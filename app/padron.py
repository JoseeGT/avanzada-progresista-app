import logging
import sqlite3
import threading
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app import config
from app.models import (
    limpiar_cedula,
    mapear_geografia_cne,
    normalizar_clave_es,
)
from app.padron_unpack import descomprimir_padron_si_falta

logger = logging.getLogger("ap_aragua.padron")

_SQLITE_TABLE_CACHE: Dict[Tuple[str, float], str] = {}
_PADRON_LOCK = threading.Lock()

# Cachés de catálogo CNE cargados una sola vez al iniciar
CENTROS_CNE_CACHE: List[Dict[str, Any]] = []
CNE_MUN_ID_MAP: Dict[str, int] = {}
CNE_PAR_ID_MAP: Dict[Tuple[str, str], Tuple[int, int]] = {}
ELECTORES_POR_MUNICIPIO: Dict[str, int] = {}
ELECTORES_POR_PARROQUIA: Dict[Tuple[str, str], int] = {}
TOTAL_ELECTORES_PADRON: int = 0


def _conectar_ro(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Abre conexión SQLite estrictamente en modo solo lectura (uri=True, ?mode=ro)."""
    path = (db_path or config.PADRON_DB_PATH).resolve()
    quoted = urllib.parse.quote(path.as_posix(), safe=":/")
    db_uri = f"file:{quoted}?mode=ro"
    conn = sqlite3.connect(db_uri, uri=True)
    conn.execute("PRAGMA query_only = ON;")
    conn.execute("PRAGMA cache_size = -8000;")
    conn.row_factory = sqlite3.Row
    return conn


def _detectar_tabla_padron(conn: sqlite3.Connection, db_path: Path) -> str:
    """Detecta y cachea la tabla disponible en el archivo SQLite del padrón."""
    resolved = str(db_path.resolve())
    mtime = db_path.stat().st_mtime
    cache_key = (resolved, mtime)
    with _PADRON_LOCK:
        cached = _SQLITE_TABLE_CACHE.get(cache_key)
    if cached:
        return cached

    cursor = conn.cursor()
    tablas = {
        r[0]
        for r in cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    tabla = "cne_electores" if "cne_electores" in tablas else "electores"
    with _PADRON_LOCK:
        _SQLITE_TABLE_CACHE.clear()
        _SQLITE_TABLE_CACHE[cache_key] = tabla
    return tabla


def asegurar_padron_prueba() -> None:
    """Si el archivo del padrón no existe, crea uno de prueba con 5 electores de Aragua."""
    db_path = config.PADRON_DB_PATH
    if db_path.exists():
        return

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS electores (
                cedula TEXT PRIMARY KEY,
                nombre_apellido TEXT NOT NULL,
                sexo TEXT NOT NULL,
                municipio TEXT NOT NULL,
                parroquia TEXT NOT NULL,
                centro_votacion TEXT NOT NULL
            )
            """
        )
        muestras = [
            (
                "12345678",
                "CARLOS EDUARDO MENDOZA RIVAS",
                "H",
                "GIRARDOT",
                "LAS DELICIAS",
                "U.E.N. LAS DELICIAS",
            ),
            (
                "15678901",
                "MARIA ALEJANDRA TORRES PEREZ",
                "M",
                "MARIO BRICEÑO IRAGORRY",
                "EL LIMON",
                "LICEO NACIONAL JULIO MORALES LARA",
            ),
            (
                "18456123",
                "JOSE GREGORIO SILVA CASTILLO",
                "H",
                "SANTIAGO MARIÑO",
                "TURMERO",
                "E.B.N. PADRE JIMENEZ",
            ),
            (
                "20112233",
                "ANA KARINA RODRIGUEZ GOMEZ",
                "M",
                "SUCRE",
                "CAGUA",
                "U.E.N. RAFAEL BOLIVAR CORONADO",
            ),
            (
                "22998877",
                "LUIS FERNANDO MARTINEZ DIAZ",
                "H",
                "JOSE FELIX RIBAS",
                "ZUATA",
                "ESCUELA BASICA ESTADAL ZUATA",
            ),
        ]
        cursor.executemany(
            """
            INSERT OR IGNORE INTO electores
            (cedula, nombre_apellido, sexo, municipio, parroquia, centro_votacion)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            muestras,
        )
        conn.commit()
    finally:
        conn.close()


def _limpiar_mesa(val: Any) -> str:
    if val is None:
        return ""
    s = str(val).strip()
    return s if s else ""


def _row_cne_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    cod_mun, nom_mun, cod_par, nom_par = mapear_geografia_cne(
        row["municipio"], row["parroquia"]
    )
    keys = set(row.keys())
    return {
        "cedula": str(row["cedula"]),
        "nacionalidad": str(row["nacionalidad"] or "V").strip().upper(),
        "nombre_apellido": str(row["nombres_apellidos"]).strip(),
        "sexo": "",
        "codigo_municipio": cod_mun,
        "municipio": nom_mun,
        "codigo_parroquia": cod_par,
        "parroquia": nom_par,
        "cod_centro": str(row["cod_centro"] or "").strip() if "cod_centro" in keys else "",
        "centro_votacion": str(row["centro_votacion"]).strip(),
        "mesa": _limpiar_mesa(row["mesa"]) if "mesa" in keys else "",
        "fecha_nacimiento": (
            str(row["fecha_nacimiento"] or "").strip()
            if "fecha_nacimiento" in keys
            else ""
        ),
    }


def _row_sample_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    cod_mun, nom_mun, cod_par, nom_par = mapear_geografia_cne(
        row["municipio"], row["parroquia"]
    )
    sexo_raw = str(row["sexo"] or "").strip().upper()
    if sexo_raw in ("F", "FEMENINO", "MUJER"):
        sexo_norm = "M"
    elif sexo_raw in ("H", "HOMBRE", "MASCULINO"):
        sexo_norm = "H"
    else:
        sexo_norm = ""

    return {
        "cedula": str(row["cedula"]),
        "nacionalidad": "V",
        "nombre_apellido": str(row["nombre_apellido"]).strip(),
        "sexo": sexo_norm,
        "codigo_municipio": cod_mun,
        "municipio": nom_mun,
        "codigo_parroquia": cod_par,
        "parroquia": nom_par,
        "cod_centro": "",
        "centro_votacion": str(row["centro_votacion"]).strip(),
        "mesa": "",
        "fecha_nacimiento": "",
    }


def cargar_catalogo_padron() -> None:
    """Carga en memoria los 657 centros de votación y totales del padrón CNE al arrancar."""
    global TOTAL_ELECTORES_PADRON
    db_path = config.PADRON_DB_PATH
    if not db_path.exists():
        try:
            descomprimir_padron_si_falta(db_path)
        except Exception as exc:
            logger.error("Error al descomprimir el padrón desde .gz: %s", exc)
    asegurar_padron_prueba()
    if not db_path.exists():
        return

    t0 = time.perf_counter()
    centros_agg: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    mun_id_map: Dict[str, int] = {}
    par_id_map: Dict[Tuple[str, str], Tuple[int, int]] = {}
    mun_totals: Dict[str, int] = defaultdict(int)
    par_totals: Dict[Tuple[str, str], int] = defaultdict(int)
    total_padron = 0

    try:
        conn = _conectar_ro(db_path)
        try:
            tabla = _detectar_tabla_padron(conn, db_path)
            cursor = conn.cursor()

            if tabla == "cne_electores":
                rows = cursor.execute(
                    """
                    SELECT municipio_id, municipio, parroquia_id, parroquia,
                           cod_centro, centro_votacion, COUNT(*) AS total
                    FROM cne_electores
                    GROUP BY municipio_id, municipio, parroquia_id, parroquia, cod_centro, centro_votacion
                    """
                ).fetchall()
                for row in rows:
                    cod_mun, nom_mun, cod_par, nom_par = mapear_geografia_cne(
                        row["municipio"], row["parroquia"]
                    )
                    cnt = int(row["total"] or 0)
                    total_padron += cnt
                    if cod_mun:
                        mun_id_map.setdefault(cod_mun, int(row["municipio_id"]))
                        mun_totals[cod_mun] += cnt
                    if cod_mun and cod_par:
                        par_id_map.setdefault(
                            (cod_mun, cod_par),
                            (int(row["municipio_id"]), int(row["parroquia_id"])),
                        )
                        par_totals[(cod_mun, cod_par)] += cnt

                    cod_c = str(row["cod_centro"] or "").strip()
                    nom_c = str(row["centro_votacion"] or "").strip()
                    agg_key = (
                        cod_mun,
                        cod_par,
                        cod_c or normalizar_clave_es(nom_c),
                    )
                    if agg_key not in centros_agg:
                        centros_agg[agg_key] = {
                            "cod_centro": cod_c,
                            "centro_votacion": nom_c,
                            "codigo_municipio": cod_mun,
                            "municipio": nom_mun,
                            "codigo_parroquia": cod_par,
                            "parroquia": nom_par,
                            "electores_padron": cnt,
                        }
                    else:
                        centros_agg[agg_key]["electores_padron"] += cnt
            else:
                rows = cursor.execute(
                    """
                    SELECT municipio, parroquia, centro_votacion, COUNT(*) AS total
                    FROM electores
                    GROUP BY municipio, parroquia, centro_votacion
                    """
                ).fetchall()
                for row in rows:
                    cod_mun, nom_mun, cod_par, nom_par = mapear_geografia_cne(
                        row["municipio"], row["parroquia"]
                    )
                    cnt = int(row["total"] or 0)
                    total_padron += cnt
                    if cod_mun:
                        mun_totals[cod_mun] += cnt
                    if cod_mun and cod_par:
                        par_totals[(cod_mun, cod_par)] += cnt
                    nom_c = str(row["centro_votacion"] or "").strip()
                    agg_key = (cod_mun, cod_par, normalizar_clave_es(nom_c))
                    centros_agg[agg_key] = {
                        "cod_centro": "",
                        "centro_votacion": nom_c,
                        "codigo_municipio": cod_mun,
                        "municipio": nom_mun,
                        "codigo_parroquia": cod_par,
                        "parroquia": nom_par,
                        "electores_padron": cnt,
                    }
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("No se pudo cargar catálogo del padrón SQLite: %s", exc)
        return

    centros_lista = sorted(
        centros_agg.values(),
        key=lambda c: (
            c["codigo_municipio"],
            c["codigo_parroquia"],
            -c["electores_padron"],
            c["centro_votacion"],
        ),
    )

    with _PADRON_LOCK:
        CENTROS_CNE_CACHE.clear()
        CENTROS_CNE_CACHE.extend(centros_lista)
        CNE_MUN_ID_MAP.clear()
        CNE_MUN_ID_MAP.update(mun_id_map)
        CNE_PAR_ID_MAP.clear()
        CNE_PAR_ID_MAP.update(par_id_map)
        ELECTORES_POR_MUNICIPIO.clear()
        ELECTORES_POR_MUNICIPIO.update(mun_totals)
        ELECTORES_POR_PARROQUIA.clear()
        ELECTORES_POR_PARROQUIA.update(par_totals)
        TOTAL_ELECTORES_PADRON = total_padron

    logger.info(
        "Catálogo CNE cargado en %.2fs: %d centros, %d electores.",
        time.perf_counter() - t0,
        len(centros_lista),
        total_padron,
    )


def buscar_elector_sqlite(cedula: str) -> Optional[Dict[str, Any]]:
    """
    Consulta el padrón CNE en SQLite SIEMPRE en modo solo lectura (uri=True, ?mode=ro)
    y usando consultas parametrizadas (?) contra SQL Injection.
    """
    cedula_limpia = limpiar_cedula(cedula)
    db_path = config.PADRON_DB_PATH
    if len(cedula_limpia) < 5 or len(cedula_limpia) > 12 or not db_path.exists():
        return None

    conn = _conectar_ro(db_path)
    try:
        tabla = _detectar_tabla_padron(conn, db_path)
        cursor = conn.cursor()

        if tabla == "cne_electores":
            cursor.execute(
                """
                SELECT cedula, nacionalidad, nombres_apellidos, municipio, parroquia,
                       cod_centro, centro_votacion, mesa, fecha_nacimiento
                FROM cne_electores
                WHERE cedula = ?
                LIMIT 1
                """,
                (int(cedula_limpia),),
            )
            row = cursor.fetchone()
            return _row_cne_to_dict(row) if row else None

        cursor.execute(
            """
            SELECT cedula, nombre_apellido, sexo, municipio, parroquia, centro_votacion
            FROM electores
            WHERE cedula = ?
            LIMIT 1
            """,
            (cedula_limpia,),
        )
        row = cursor.fetchone()
        return _row_sample_to_dict(row) if row else None
    finally:
        conn.close()


def buscar_electores_por_lote_sqlite(cedulas: List[str]) -> Dict[str, Dict[str, Any]]:
    """Consulta múltiples cédulas en bloques seguros (WHERE cedula IN (...)) en modo RO."""
    limpias: List[str] = []
    vistas = set()
    for c in cedulas:
        ced = limpiar_cedula(c)
        if 5 <= len(ced) <= 12 and ced not in vistas:
            vistas.add(ced)
            limpias.append(ced)

    db_path = config.PADRON_DB_PATH
    if not limpias or not db_path.exists():
        return {}

    resultados: Dict[str, Dict[str, Any]] = {}
    conn = _conectar_ro(db_path)
    try:
        tabla = _detectar_tabla_padron(conn, db_path)
        cursor = conn.cursor()
        chunk_size = 400
        for i in range(0, len(limpias), chunk_size):
            chunk = limpias[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            if tabla == "cne_electores":
                params = [int(c) for c in chunk]
                rows = cursor.execute(
                    f"""
                    SELECT cedula, nacionalidad, nombres_apellidos, municipio, parroquia,
                           cod_centro, centro_votacion, mesa, fecha_nacimiento
                    FROM cne_electores
                    WHERE cedula IN ({placeholders})
                    """,
                    params,
                ).fetchall()
                for row in rows:
                    item = _row_cne_to_dict(row)
                    resultados[item["cedula"]] = item
            else:
                rows = cursor.execute(
                    f"""
                    SELECT cedula, nombre_apellido, sexo, municipio, parroquia, centro_votacion
                    FROM electores
                    WHERE cedula IN ({placeholders})
                    """,
                    chunk,
                ).fetchall()
                for row in rows:
                    item = _row_sample_to_dict(row)
                    resultados[item["cedula"]] = item
    finally:
        conn.close()
    return resultados


def _escape_like(token: str) -> str:
    return token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def buscar_electores_por_nombre_sqlite(
    query: str,
    codigo_municipio: str = "",
    codigo_parroquia: str = "",
    limit: int = 25,
) -> List[Dict[str, Any]]:
    """Busca electores por tokens de nombre y apellido en el padrón CNE (modo solo lectura)."""
    tokens = [
        t for t in normalizar_clave_es(query).split(" ") if len(t) >= 2
    ][:5]
    if not tokens:
        return []

    db_path = config.PADRON_DB_PATH
    if not db_path.exists():
        return []

    max_rows = max(1, min(int(limit or 25), 50))
    cod_mun = str(codigo_municipio or "").strip().zfill(2) if codigo_municipio else ""
    cod_par = str(codigo_parroquia or "").strip().zfill(2) if codigo_parroquia else ""

    conn = _conectar_ro(db_path)
    try:
        tabla = _detectar_tabla_padron(conn, db_path)
        cursor = conn.cursor()

        if tabla == "cne_electores":
            where_clauses: List[str] = []
            params: List[Any] = []

            if cod_mun and cod_par and (cod_mun, cod_par) in CNE_PAR_ID_MAP:
                cne_mun_id, cne_par_id = CNE_PAR_ID_MAP[(cod_mun, cod_par)]
                where_clauses.append("municipio_id = ?")
                params.append(cne_mun_id)
                where_clauses.append("parroquia_id = ?")
                params.append(cne_par_id)
            elif cod_mun and cod_mun in CNE_MUN_ID_MAP:
                where_clauses.append("municipio_id = ?")
                params.append(CNE_MUN_ID_MAP[cod_mun])

            for tok in tokens:
                where_clauses.append(r"nombres_apellidos LIKE ? ESCAPE '\'")
                params.append(f"%{_escape_like(tok)}%")

            sql = f"""
                SELECT cedula, nacionalidad, nombres_apellidos, municipio, parroquia,
                       cod_centro, centro_votacion, mesa, fecha_nacimiento
                FROM cne_electores
                WHERE {' AND '.join(where_clauses)}
                LIMIT ?
            """
            params.append(max_rows)
            rows = cursor.execute(sql, params).fetchall()
            return [_row_cne_to_dict(r) for r in rows]

        where_clauses = []
        params = []
        for tok in tokens:
            where_clauses.append(r"nombre_apellido LIKE ? ESCAPE '\'")
            params.append(f"%{_escape_like(tok)}%")
        sql = f"""
            SELECT cedula, nombre_apellido, sexo, municipio, parroquia, centro_votacion
            FROM electores
            WHERE {' AND '.join(where_clauses)}
            LIMIT ?
        """
        params.append(max_rows)
        rows = cursor.execute(sql, params).fetchall()
        items = [_row_sample_to_dict(r) for r in rows]
        if cod_mun:
            items = [x for x in items if x["codigo_municipio"] == cod_mun]
        if cod_par:
            items = [x for x in items if x["codigo_parroquia"] == cod_par]
        return items[:max_rows]
    finally:
        conn.close()


def listar_centros_cne(
    codigo_municipio: str = "",
    codigo_parroquia: str = "",
    q: str = "",
    limit: int = 80,
) -> List[Dict[str, Any]]:
    """Retorna centros oficiales del padrón CNE filtrados 100% en memoria."""
    cod_mun = str(codigo_municipio or "").strip().zfill(2) if codigo_municipio else ""
    cod_par = str(codigo_parroquia or "").strip().zfill(2) if codigo_parroquia else ""
    q_norm = normalizar_clave_es(q)
    max_rows = max(1, min(int(limit or 80), 700))

    with _PADRON_LOCK:
        centros = list(CENTROS_CNE_CACHE)

    filtrados: List[Dict[str, Any]] = []
    for c in centros:
        if cod_mun and c["codigo_municipio"] != cod_mun:
            continue
        if cod_par and c["codigo_parroquia"] != cod_par:
            continue
        if q_norm:
            hay = normalizar_clave_es(f"{c['cod_centro']} {c['centro_votacion']}")
            if q_norm not in hay:
                continue
        filtrados.append(dict(c))
        if len(filtrados) >= max_rows:
            break
    return filtrados


def obtener_resumen_padron() -> Dict[str, Any]:
    with _PADRON_LOCK:
        return {
            "padron_disponible": config.PADRON_DB_PATH.exists(),
            "total_centros_cne": len(CENTROS_CNE_CACHE),
            "total_electores_padron": TOTAL_ELECTORES_PADRON,
        }

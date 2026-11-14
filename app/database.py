import json
import os
import re
import sqlite3
import threading
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.models import (
    CATALOGO_GEOGRAFICO,
    limpiar_cedula,
    mapear_geografia_cne,
    normalizar_texto,
    obtener_municipio_por_codigo,
)

BASE_DIR = Path(__file__).resolve().parent.parent
PADRON_DB_PATH = Path(os.getenv("PADRON_DB_PATH", str(BASE_DIR / "padron_cne.db")))
FIREBASE_CRED_PATH = Path(
    os.getenv("FIREBASE_CREDENTIALS_PATH", str(BASE_DIR / "serviceAccountKey.json"))
)
LOCAL_FALLBACK_PATH = Path(
    os.getenv("LOCAL_FALLBACK_PATH", str(BASE_DIR / "activistas_local.json"))
)

# Caché en memoria (Cuota Cero para Firestore)
ACTIVISTAS_CACHE: Dict[str, Dict[str, Any]] = {}
CACHE_LOCK = threading.Lock()

# Estado del backend de persistencia
_FIRESTORE_DB = None
_MODO_PERSISTENCIA = "local_json"  # "firestore" o "local_json"


def _asegurar_padron_prueba() -> None:
    """Si padron_aragua.db no existe, crea uno de prueba con 5 electores de Aragua."""
    if PADRON_DB_PATH.exists():
        return

    PADRON_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(PADRON_DB_PATH))
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


def buscar_elector_sqlite(cedula: str) -> Optional[Dict[str, Any]]:
    """
    Consulta el padrón CNE en SQLite SIEMPRE en modo solo lectura (uri=True, ?mode=ro)
    y usando consultas parametrizadas (?) contra SQL Injection.
    Soporta el padrón real (tabla cne_electores en padron_cne.db) y fallback de prueba (electores).
    """
    cedula_limpia = limpiar_cedula(cedula)
    if not cedula_limpia or not PADRON_DB_PATH.exists():
        return None

    db_uri = f"file:{PADRON_DB_PATH.resolve().as_posix()}?mode=ro"
    conn = sqlite3.connect(db_uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        tablas = {
            r[0]
            for r in cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }

        if "cne_electores" in tablas:
            cursor.execute(
                """
                SELECT cedula, nacionalidad, nombres_apellidos, municipio, parroquia, centro_votacion
                FROM cne_electores
                WHERE cedula = ?
                LIMIT 1
                """,
                (int(cedula_limpia),),
            )
            row = cursor.fetchone()
            if not row:
                return None

            cod_mun, nom_mun, cod_par, nom_par = mapear_geografia_cne(
                row["municipio"], row["parroquia"]
            )
            return {
                "cedula": str(row["cedula"]),
                "nacionalidad": str(row["nacionalidad"] or "V").strip().upper(),
                "nombre_apellido": str(row["nombres_apellidos"]).strip(),
                "sexo": "",
                "codigo_municipio": cod_mun,
                "municipio": nom_mun,
                "codigo_parroquia": cod_par,
                "parroquia": nom_par,
                "centro_votacion": str(row["centro_votacion"]).strip(),
            }

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
        if not row:
            return None

        cod_mun, nom_mun, cod_par, nom_par = mapear_geografia_cne(
            row["municipio"], row["parroquia"]
        )
        sexo_raw = str(row["sexo"] or "").strip().upper()
        if sexo_raw in ("F", "FEMENINO", "MUJER"):
            sexo_norm = "M"
        elif sexo_raw in ("H", "HOMBRE", "MASCULINO"):
            sexo_norm = "H"
        else:
            sexo_norm = sexo_raw[:1] if sexo_raw else ""

        return {
            "cedula": str(row["cedula"]),
            "nombre_apellido": str(row["nombre_apellido"]).strip(),
            "sexo": sexo_norm,
            "codigo_municipio": cod_mun,
            "municipio": nom_mun,
            "codigo_parroquia": cod_par,
            "parroquia": nom_par,
            "centro_votacion": str(row["centro_votacion"]).strip(),
        }
    finally:
        conn.close()


def _guardar_fallback_json_locked() -> None:
    """Guarda el caché actual en activistas_local.json de forma atómica (requiere CACHE_LOCK)."""
    LOCAL_FALLBACK_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = LOCAL_FALLBACK_PATH.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(ACTIVISTAS_CACHE, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, LOCAL_FALLBACK_PATH)


def init_databases() -> None:
    """Inicializa padrón SQLite (si falta) y carga en memoria la colección activistas."""
    global _FIRESTORE_DB, _MODO_PERSISTENCIA

    _asegurar_padron_prueba()

    with CACHE_LOCK:
        ACTIVISTAS_CACHE.clear()

        if FIREBASE_CRED_PATH.exists():
            try:
                import firebase_admin
                from firebase_admin import credentials, firestore

                if not firebase_admin._apps:
                    cred = credentials.Certificate(str(FIREBASE_CRED_PATH))
                    firebase_admin.initialize_app(cred)
                _FIRESTORE_DB = firestore.client()
                _MODO_PERSISTENCIA = "firestore"

                # Carga ÚNICA inicial en memoria (Cuota Cero en lecturas posteriores)
                docs = _FIRESTORE_DB.collection("activistas").stream()
                for doc in docs:
                    data = doc.to_dict() or {}
                    ced = limpiar_cedula(data.get("cedula") or doc.id)
                    if ced:
                        data["cedula"] = ced
                        ACTIVISTAS_CACHE[ced] = data
                return
            except Exception as exc:
                print(f"[AVISO] No se pudo inicializar Firestore ({exc}). Activando Fallback JSON local.")

        # Modo Fallback local en JSON
        _FIRESTORE_DB = None
        _MODO_PERSISTENCIA = "local_json"
        if LOCAL_FALLBACK_PATH.exists():
            try:
                with open(LOCAL_FALLBACK_PATH, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                if isinstance(raw, dict):
                    for k, v in raw.items():
                        ced = limpiar_cedula((v or {}).get("cedula") or k)
                        if ced and isinstance(v, dict):
                            v["cedula"] = ced
                            ACTIVISTAS_CACHE[ced] = v
            except Exception as exc:
                print(f"[AVISO] Error leyendo {LOCAL_FALLBACK_PATH}: {exc}")


def obtener_estado_sistema() -> Dict[str, Any]:
    with CACHE_LOCK:
        total = len(ACTIVISTAS_CACHE)
    return {
        "modo_persistencia": _MODO_PERSISTENCIA,
        "total_activistas": total,
        "padron_disponible": PADRON_DB_PATH.exists(),
    }


def generar_codigo_planilla(codigo_municipio: str) -> str:
    """Genera el siguiente código formato AP-{COD_MUNICIPIO}-{CORRELATIVO} usando el caché."""
    cod_mun = str(codigo_municipio or "01").strip().zfill(2)
    prefijo = f"AP-{cod_mun}-"
    max_num = 0
    with CACHE_LOCK:
        for item in ACTIVISTAS_CACHE.values():
            cod = str(item.get("codigo") or "").strip().upper()
            if cod.startswith(prefijo):
                sufijo = cod[len(prefijo) :]
                if sufijo.isdigit():
                    max_num = max(max_num, int(sufijo))
    return f"{prefijo}{max_num + 1:04d}"


def obtener_activista_cache(cedula: str) -> Optional[Dict[str, Any]]:
    ced = limpiar_cedula(cedula)
    with CACHE_LOCK:
        item = ACTIVISTAS_CACHE.get(ced)
        return dict(item) if item else None


def guardar_activista_db(datos: Dict[str, Any]) -> Dict[str, Any]:
    """Guarda o actualiza un activista en Firestore (o Fallback JSON) y actualiza el caché."""
    ced = limpiar_cedula(datos.get("cedula", ""))
    ahora = datetime.now(timezone.utc).isoformat()

    # Completar nombres oficiales de municipio y parroquia desde catálogo
    mun_obj = obtener_municipio_por_codigo(datos.get("codigo_municipio", ""))
    if mun_obj:
        datos["codigo_municipio"] = mun_obj["codigo"]
        datos["municipio"] = mun_obj["nombre"]
        cod_par = str(datos.get("codigo_parroquia", "")).strip().zfill(2)
        for par in mun_obj["parroquias"]:
            if par["codigo"] == cod_par:
                datos["codigo_parroquia"] = par["codigo"]
                datos["parroquia"] = par["nombre"]
                break

    with CACHE_LOCK:
        existente = ACTIVISTAS_CACHE.get(ced)
        if not datos.get("codigo"):
            if existente and existente.get("codigo"):
                datos["codigo"] = existente["codigo"]
            else:
                # Calcular correlativo sin deadlock (inline)
                cod_mun = str(datos.get("codigo_municipio") or "01").zfill(2)
                prefijo = f"AP-{cod_mun}-"
                max_num = 0
                for item in ACTIVISTAS_CACHE.values():
                    c = str(item.get("codigo") or "").strip().upper()
                    if c.startswith(prefijo) and c[len(prefijo) :].isdigit():
                        max_num = max(max_num, int(c[len(prefijo) :]))
                datos["codigo"] = f"{prefijo}{max_num + 1:04d}"

        datos["fecha_registro"] = (
            existente.get("fecha_registro", ahora) if existente else ahora
        )
        datos["fecha_actualizacion"] = ahora

        if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
            _FIRESTORE_DB.collection("activistas").document(ced).set(datos)
        else:
            ACTIVISTAS_CACHE[ced] = dict(datos)
            _guardar_fallback_json_locked()

        ACTIVISTAS_CACHE[ced] = dict(datos)
        return dict(datos)


def eliminar_activista_db(cedula: str) -> bool:
    """Elimina un activista de Firestore (o Fallback JSON) y del caché en memoria."""
    ced = limpiar_cedula(cedula)
    with CACHE_LOCK:
        if ced not in ACTIVISTAS_CACHE:
            return False

        if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
            _FIRESTORE_DB.collection("activistas").document(ced).delete()
            ACTIVISTAS_CACHE.pop(ced, None)
        else:
            ACTIVISTAS_CACHE.pop(ced, None)
            _guardar_fallback_json_locked()
        return True


def filtrar_activistas(
    cedula: Optional[str] = None,
    codigo: Optional[str] = None,
    codigo_municipio: Optional[str] = None,
    codigo_parroquia: Optional[str] = None,
    centro_votacion: Optional[str] = None,
    enlace: Optional[str] = None,
    responsable_cal: Optional[str] = None,
    responsable_local: Optional[str] = None,
    comunidad: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Ejecuta búsqueda por cédula y los 8 filtros combinables 100% sobre el caché en memoria."""
    ced_q = limpiar_cedula(cedula) if cedula else ""
    cod_q = normalizar_texto(codigo)
    mun_q = str(codigo_municipio).strip().zfill(2) if codigo_municipio and str(codigo_municipio).strip() else ""
    par_q = str(codigo_parroquia).strip().zfill(2) if codigo_parroquia and str(codigo_parroquia).strip() else ""
    centro_q = normalizar_texto(centro_votacion)
    enlace_q = normalizar_texto(enlace)
    resp_cal_q = normalizar_texto(responsable_cal)
    resp_loc_q = normalizar_texto(responsable_local)
    comunidad_q = normalizar_texto(comunidad)

    with CACHE_LOCK:
        registros = list(ACTIVISTAS_CACHE.values())

    resultados: List[Dict[str, Any]] = []
    for r in registros:
        if ced_q and ced_q not in str(r.get("cedula", "")):
            continue
        if cod_q and cod_q not in normalizar_texto(r.get("codigo", "")):
            continue
        if mun_q and str(r.get("codigo_municipio", "")).zfill(2) != mun_q:
            continue
        if par_q and str(r.get("codigo_parroquia", "")).zfill(2) != par_q:
            continue
        if centro_q and centro_q not in normalizar_texto(r.get("centro_votacion", "")):
            continue
        if enlace_q and enlace_q not in normalizar_texto(r.get("enlace", "")):
            continue
        if resp_cal_q and resp_cal_q not in normalizar_texto(r.get("responsable_cal", "")):
            continue
        if resp_loc_q and resp_loc_q not in normalizar_texto(r.get("responsable_local", "")):
            continue
        if comunidad_q and comunidad_q not in normalizar_texto(r.get("comunidad", "")):
            continue
        resultados.append(dict(r))

    resultados.sort(key=lambda x: str(x.get("codigo", "")))
    return resultados


def _construir_desglose(contador: Counter, total: int) -> List[Dict[str, Any]]:
    if total == 0:
        return []
    salida = []
    for etiqueta, cantidad in contador.most_common():
        porcentaje = round((cantidad * 100.0) / total, 2)
        salida.append(
            {
                "etiqueta": etiqueta,
                "cantidad": cantidad,
                "porcentaje": porcentaje,
            }
        )
    return salida


def calcular_estadisticas() -> Dict[str, Any]:
    """Calcula conteos y porcentajes exactos sobre el caché en memoria (Cuota Cero)."""
    with CACHE_LOCK:
        registros = list(ACTIVISTAS_CACHE.values())

    total = len(registros)
    c_centro = Counter()
    c_parroquia = Counter()
    c_municipio = Counter()
    c_comunidad = Counter()
    c_resp_mun = Counter()
    c_resp_cal = Counter()

    for r in registros:
        centro = str(r.get("centro_votacion") or "").strip() or "SIN ESPECIFICAR"
        mun = str(r.get("municipio") or "").strip() or "SIN ESPECIFICAR"
        par = str(r.get("parroquia") or "").strip() or "SIN ESPECIFICAR"
        par_label = f"{par} ({mun})" if mun != "SIN ESPECIFICAR" else par
        com = str(r.get("comunidad") or "").strip() or "SIN ESPECIFICAR"
        rmun = str(r.get("responsable_municipal") or "").strip() or "SIN ESPECIFICAR"
        rcal = str(r.get("responsable_cal") or "").strip() or "SIN ESPECIFICAR"

        c_centro[centro] += 1
        c_parroquia[par_label] += 1
        c_municipio[mun] += 1
        c_comunidad[com] += 1
        c_resp_mun[rmun] += 1
        c_resp_cal[rcal] += 1

    return {
        "total_registrados": total,
        "por_centro_votacion": _construir_desglose(c_centro, total),
        "por_parroquia": _construir_desglose(c_parroquia, total),
        "por_municipio": _construir_desglose(c_municipio, total),
        "por_comunidad": _construir_desglose(c_comunidad, total),
        "por_responsable_municipal": _construir_desglose(c_resp_mun, total),
        "por_responsable_cal": _construir_desglose(c_resp_cal, total),
    }

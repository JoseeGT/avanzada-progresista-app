import hashlib
import json
import os
import re
import sqlite3
import threading
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.models import (
    CATALOGO_GEOGRAFICO,
    ROLES_ESTRUCTURA,
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
LOCAL_ESTRUCTURA_PATH = Path(
    os.getenv("LOCAL_ESTRUCTURA_PATH", str(BASE_DIR / "estructura_local.json"))
)

# Caché en memoria (Cuota Cero para Firestore)
ACTIVISTAS_CACHE: Dict[str, Dict[str, Any]] = {}
ESTRUCTURA_CACHE: Dict[str, Dict[str, Any]] = {}
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


def _guardar_json_atomico(path: Path, payload: Dict[str, Any]) -> None:
    """Guarda un diccionario JSON en disco de forma atómica."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def _guardar_fallback_json_locked() -> None:
    """Guarda el caché actual en activistas_local.json de forma atómica (requiere CACHE_LOCK)."""
    _guardar_json_atomico(LOCAL_FALLBACK_PATH, ACTIVISTAS_CACHE)


def _guardar_estructura_json_locked() -> None:
    """Guarda el caché de estructura y responsables en estructura_local.json (requiere CACHE_LOCK)."""
    _guardar_json_atomico(LOCAL_ESTRUCTURA_PATH, ESTRUCTURA_CACHE)


def _estructura_id(rol: str, nombre: str) -> str:
    """Genera un identificador estable y seguro para Firestore por (rol, nombre)."""
    rol_clean = str(rol or "").strip().lower()
    nombre_norm = re.sub(r"\s+", " ", str(nombre or "")).strip().upper()
    digest = hashlib.sha1(f"{rol_clean}|{nombre_norm}".encode("utf-8")).hexdigest()[:12]
    return f"{rol_clean}__{digest}"


def _asegurar_estructura_item_locked(
    rol: str,
    nombre: str,
    ahora: str,
    cedula: str = "",
    telefono: str = "",
    codigo_municipio: str = "",
    municipio: str = "",
    sobrescribir_meta: bool = False,
) -> Optional[Tuple[Dict[str, Any], bool]]:
    """Inserta o actualiza un responsable en ESTRUCTURA_CACHE (requiere CACHE_LOCK)."""
    rol_clean = str(rol or "").strip().lower()
    nombre_norm = re.sub(r"\s+", " ", str(nombre or "")).strip().upper()
    if rol_clean not in ROLES_ESTRUCTURA or len(nombre_norm) < 2:
        return None

    cod_mun = str(codigo_municipio or "").strip()
    cod_mun = cod_mun.zfill(2) if cod_mun.isdigit() else ""
    nom_mun = str(municipio or "").strip()
    if cod_mun:
        mun_obj = obtener_municipio_por_codigo(cod_mun)
        if mun_obj:
            cod_mun = mun_obj["codigo"]
            nom_mun = mun_obj["nombre"]

    item_id = _estructura_id(rol_clean, nombre_norm)
    existente = ESTRUCTURA_CACHE.get(item_id)
    if existente:
        if not sobrescribir_meta:
            return dict(existente), False
        actualizado = dict(existente)
        actualizado["cedula"] = limpiar_cedula(cedula) if cedula is not None else existente.get("cedula", "")
        actualizado["telefono"] = re.sub(r"\s+", " ", str(telefono or "")).strip()
        actualizado["codigo_municipio"] = cod_mun
        actualizado["municipio"] = nom_mun
        actualizado["fecha_actualizacion"] = ahora
        ESTRUCTURA_CACHE[item_id] = actualizado
        return dict(actualizado), False

    nuevo = {
        "id": item_id,
        "rol": rol_clean,
        "nombre": nombre_norm,
        "cedula": limpiar_cedula(cedula) if cedula else "",
        "telefono": re.sub(r"\s+", " ", str(telefono or "")).strip(),
        "codigo_municipio": cod_mun,
        "municipio": nom_mun,
        "fecha_registro": ahora,
        "fecha_actualizacion": ahora,
    }
    ESTRUCTURA_CACHE[item_id] = nuevo
    return dict(nuevo), True


def _extraer_estructura_de_activista_locked(
    activista: Dict[str, Any], ahora: str
) -> List[Dict[str, Any]]:
    """Registra automáticamente en ESTRUCTURA_CACHE cualquier responsable nuevo presente en un activista."""
    creados: List[Dict[str, Any]] = []
    cod_mun = str(activista.get("codigo_municipio") or "")
    nom_mun = str(activista.get("municipio") or "")
    for rol in ROLES_ESTRUCTURA:
        val = str(activista.get(rol) or "").strip()
        if len(val) < 2:
            continue
        res = _asegurar_estructura_item_locked(
            rol=rol,
            nombre=val,
            ahora=ahora,
            codigo_municipio=cod_mun,
            municipio=nom_mun,
            sobrescribir_meta=False,
        )
        if res and res[1]:
            creados.append(res[0])
    return creados


def init_databases() -> None:
    """Inicializa padrón SQLite (si falta) y carga en memoria activistas y estructura."""
    global _FIRESTORE_DB, _MODO_PERSISTENCIA

    _asegurar_padron_prueba()

    with CACHE_LOCK:
        ACTIVISTAS_CACHE.clear()
        ESTRUCTURA_CACHE.clear()

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
                for doc in _FIRESTORE_DB.collection("activistas").stream():
                    data = doc.to_dict() or {}
                    ced = limpiar_cedula(data.get("cedula") or doc.id)
                    if ced:
                        data["cedula"] = ced
                        ACTIVISTAS_CACHE[ced] = data

                for doc in _FIRESTORE_DB.collection("estructura").stream():
                    data = doc.to_dict() or {}
                    rol = str(data.get("rol") or "").strip().lower()
                    nombre = re.sub(r"\s+", " ", str(data.get("nombre") or "")).strip().upper()
                    if rol in ROLES_ESTRUCTURA and len(nombre) >= 2:
                        item_id = str(data.get("id") or _estructura_id(rol, nombre))
                        data["id"] = item_id
                        data["rol"] = rol
                        data["nombre"] = nombre
                        ESTRUCTURA_CACHE[item_id] = data

                if not ESTRUCTURA_CACHE and ACTIVISTAS_CACHE:
                    ahora = datetime.now(timezone.utc).isoformat()
                    sembrados: List[Dict[str, Any]] = []
                    for act in ACTIVISTAS_CACHE.values():
                        sembrados.extend(_extraer_estructura_de_activista_locked(act, ahora))
                    if sembrados:
                        batch = _FIRESTORE_DB.batch()
                        col = _FIRESTORE_DB.collection("estructura")
                        for item in sembrados:
                            batch.set(col.document(item["id"]), item)
                        batch.commit()
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

        if LOCAL_ESTRUCTURA_PATH.exists():
            try:
                with open(LOCAL_ESTRUCTURA_PATH, "r", encoding="utf-8") as f:
                    raw_est = json.load(f)
                if isinstance(raw_est, dict):
                    for k, v in raw_est.items():
                        if not isinstance(v, dict):
                            continue
                        rol = str(v.get("rol") or "").strip().lower()
                        nombre = re.sub(r"\s+", " ", str(v.get("nombre") or "")).strip().upper()
                        if rol in ROLES_ESTRUCTURA and len(nombre) >= 2:
                            item_id = str(v.get("id") or k or _estructura_id(rol, nombre))
                            v["id"] = item_id
                            v["rol"] = rol
                            v["nombre"] = nombre
                            ESTRUCTURA_CACHE[item_id] = v
            except Exception as exc:
                print(f"[AVISO] Error leyendo {LOCAL_ESTRUCTURA_PATH}: {exc}")
        elif ACTIVISTAS_CACHE:
            ahora = datetime.now(timezone.utc).isoformat()
            for act in ACTIVISTAS_CACHE.values():
                _extraer_estructura_de_activista_locked(act, ahora)
            if ESTRUCTURA_CACHE:
                _guardar_estructura_json_locked()


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


def _calcular_siguiente_codigo_locked(codigo_municipio: str) -> str:
    """Calcula el siguiente correlativo AP-XX-XXXX (requiere CACHE_LOCK)."""
    cod_mun = str(codigo_municipio or "01").strip().zfill(2)
    prefijo = f"AP-{cod_mun}-"
    max_num = 0
    for item in ACTIVISTAS_CACHE.values():
        c = str(item.get("codigo") or "").strip().upper()
        if c.startswith(prefijo) and c[len(prefijo) :].isdigit():
            max_num = max(max_num, int(c[len(prefijo) :]))
    return f"{prefijo}{max_num + 1:04d}"


def _preparar_activista_locked(
    datos: Dict[str, Any],
    ahora: str,
    codigo_lote: Optional[str] = None,
) -> Dict[str, Any]:
    """Normaliza geografía, código y fechas de un activista antes de persistir (requiere CACHE_LOCK)."""
    datos = dict(datos)
    ced = limpiar_cedula(datos.get("cedula", ""))
    datos["cedula"] = ced

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

    existente = ACTIVISTAS_CACHE.get(ced)
    if not datos.get("codigo"):
        if existente and existente.get("codigo"):
            datos["codigo"] = existente["codigo"]
        elif codigo_lote:
            datos["codigo"] = codigo_lote
        else:
            datos["codigo"] = _calcular_siguiente_codigo_locked(
                datos.get("codigo_municipio") or "01"
            )

    datos["fecha_registro"] = (
        existente.get("fecha_registro", ahora) if existente else ahora
    )
    datos["fecha_actualizacion"] = ahora
    return datos


def guardar_activista_db(datos: Dict[str, Any]) -> Dict[str, Any]:
    """Guarda o actualiza un activista en Firestore (o Fallback JSON) y actualiza el caché."""
    ahora = datetime.now(timezone.utc).isoformat()

    with CACHE_LOCK:
        preparado = _preparar_activista_locked(datos, ahora)
        ced = preparado["cedula"]
        nuevos_est = _extraer_estructura_de_activista_locked(preparado, ahora)

        if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
            _FIRESTORE_DB.collection("activistas").document(ced).set(preparado)
            if nuevos_est:
                col_est = _FIRESTORE_DB.collection("estructura")
                for est_item in nuevos_est:
                    col_est.document(est_item["id"]).set(est_item)
        else:
            ACTIVISTAS_CACHE[ced] = dict(preparado)
            _guardar_fallback_json_locked()
            if nuevos_est:
                _guardar_estructura_json_locked()

        ACTIVISTAS_CACHE[ced] = dict(preparado)
        return dict(preparado)


def guardar_activistas_lote_db(lista_datos: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Guarda o actualiza múltiples activistas de una planilla en un solo lote (Cuota Cero en lecturas)."""
    ahora = datetime.now(timezone.utc).isoformat()
    guardados: List[Dict[str, Any]] = []
    nuevos = 0
    actualizados = 0

    with CACHE_LOCK:
        codigo_fallback = None
        for d in lista_datos:
            if d.get("codigo"):
                codigo_fallback = str(d["codigo"]).strip().upper()
                break
        if not codigo_fallback and lista_datos:
            codigo_fallback = _calcular_siguiente_codigo_locked(
                lista_datos[0].get("codigo_municipio") or "01"
            )

        preparados_por_ced: Dict[str, Dict[str, Any]] = {}
        nuevos_est: List[Dict[str, Any]] = []
        for d in lista_datos:
            preparado = _preparar_activista_locked(d, ahora, codigo_lote=codigo_fallback)
            ced = preparado["cedula"]
            if ced in ACTIVISTAS_CACHE or ced in preparados_por_ced:
                actualizados += 1
            else:
                nuevos += 1
            preparados_por_ced[ced] = preparado
            nuevos_est.extend(_extraer_estructura_de_activista_locked(preparado, ahora))

        if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
            batch = _FIRESTORE_DB.batch()
            col = _FIRESTORE_DB.collection("activistas")
            for ced, item in preparados_por_ced.items():
                batch.set(col.document(ced), item)
            if nuevos_est:
                col_est = _FIRESTORE_DB.collection("estructura")
                for est_item in nuevos_est:
                    batch.set(col_est.document(est_item["id"]), est_item)
            batch.commit()
        else:
            for ced, item in preparados_por_ced.items():
                ACTIVISTAS_CACHE[ced] = dict(item)
            _guardar_fallback_json_locked()
            if nuevos_est:
                _guardar_estructura_json_locked()

        for ced, item in preparados_por_ced.items():
            ACTIVISTAS_CACHE[ced] = dict(item)
            guardados.append(dict(item))

    return {
        "total_procesados": len(guardados),
        "nuevos": nuevos,
        "actualizados": actualizados,
        "codigo_planilla": codigo_fallback or "",
        "activistas": guardados,
    }


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


def listar_estructura_cache(rol: Optional[str] = None) -> List[Dict[str, Any]]:
    """Lista los responsables de estructura 100% desde caché en memoria."""
    rol_q = str(rol or "").strip().lower()
    with CACHE_LOCK:
        items = [dict(v) for v in ESTRUCTURA_CACHE.values()]
    if rol_q:
        items = [i for i in items if i.get("rol") == rol_q]
    items.sort(key=lambda x: (str(x.get("rol", "")), str(x.get("nombre", ""))))
    return items


def guardar_estructura_db(datos: Dict[str, Any]) -> Dict[str, Any]:
    """Guarda o actualiza un responsable de estructura en Firestore (o JSON local) y caché."""
    ahora = datetime.now(timezone.utc).isoformat()
    with CACHE_LOCK:
        res = _asegurar_estructura_item_locked(
            rol=str(datos.get("rol") or ""),
            nombre=str(datos.get("nombre") or ""),
            ahora=ahora,
            cedula=str(datos.get("cedula") or ""),
            telefono=str(datos.get("telefono") or ""),
            codigo_municipio=str(datos.get("codigo_municipio") or ""),
            municipio=str(datos.get("municipio") or ""),
            sobrescribir_meta=True,
        )
        if not res:
            raise ValueError("Rol o nombre inválido para estructura.")
        item, creado = res

        if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
            _FIRESTORE_DB.collection("estructura").document(item["id"]).set(item)
        else:
            _guardar_estructura_json_locked()

        return {"item": item, "creado": creado}


def eliminar_estructura_db(item_id: str) -> bool:
    """Elimina un responsable de estructura de Firestore (o JSON local) y del caché."""
    clean_id = str(item_id or "").strip()
    with CACHE_LOCK:
        if clean_id not in ESTRUCTURA_CACHE:
            return False
        if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
            _FIRESTORE_DB.collection("estructura").document(clean_id).delete()
            ESTRUCTURA_CACHE.pop(clean_id, None)
        else:
            ESTRUCTURA_CACHE.pop(clean_id, None)
            _guardar_estructura_json_locked()
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
    responsable_comunidad: Optional[str] = None,
    comunidad: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Ejecuta búsqueda por cédula y los filtros combinables 100% sobre el caché en memoria."""
    ced_q = limpiar_cedula(cedula) if cedula else ""
    cod_q = normalizar_texto(codigo)
    mun_q = str(codigo_municipio).strip().zfill(2) if codigo_municipio and str(codigo_municipio).strip() else ""
    par_q = str(codigo_parroquia).strip().zfill(2) if codigo_parroquia and str(codigo_parroquia).strip() else ""
    centro_q = normalizar_texto(centro_votacion)
    enlace_q = normalizar_texto(enlace)
    resp_cal_q = normalizar_texto(responsable_cal)
    resp_loc_q = normalizar_texto(responsable_local)
    resp_com_q = normalizar_texto(responsable_comunidad)
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
        if resp_com_q and resp_com_q not in normalizar_texto(r.get("responsable_comunidad", "")):
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

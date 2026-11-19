import hashlib
import json
import logging
import re
import threading
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app import config, padron
from app.models import (
    CATALOGO_GEOGRAFICO,
    ROLES_ESTRUCTURA,
    formatear_codigo_planilla,
    limpiar_cedula,
    normalizar_clave_es,
    normalizar_codigo_representante,
    normalizar_texto,
    obtener_municipio_por_codigo,
)

# Re-exportar para compatibilidad con callers existentes
buscar_elector_sqlite = padron.buscar_elector_sqlite

logger = logging.getLogger("ap_aragua.database")

# Caché en memoria (Cuota Cero para Firestore)
ACTIVISTAS_CACHE: Dict[str, Dict[str, Any]] = {}
ESTRUCTURA_CACHE: Dict[str, Dict[str, Any]] = {}
USUARIOS_CACHE: Dict[str, Dict[str, Any]] = {}
CACHE_LOCK = threading.Lock()

# Estado del backend de persistencia
_FIRESTORE_DB = None
_MODO_PERSISTENCIA = "local_json"  # "firestore" o "local_json"

_PATRON_CODIGO_TRUNCADO = re.compile(r"^AP-\d{1,2}-?$")
_PATRON_AUTO_BACKUP = re.compile(r"^auto_(\d{8})_(\d{6})_([a-z0-9_]+)\.json$")


def _es_codigo_truncado(codigo: Optional[str]) -> bool:
    """Retorna True si el código es vacío o solo un prefijo sin correlativo (ej. AP-01)."""
    cod = re.sub(r"\s+", "", str(codigo or "")).strip().upper()
    return (not cod) or bool(_PATRON_CODIGO_TRUNCADO.match(cod))


def _guardar_json_atomico(path: Path, payload: Dict[str, Any]) -> None:
    """Guarda un diccionario JSON en disco de forma atómica."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    import os

    os.replace(tmp_path, path)


def _guardar_fallback_json_locked() -> None:
    """Guarda el caché actual en activistas_local.json de forma atómica (requiere CACHE_LOCK)."""
    _guardar_json_atomico(config.LOCAL_FALLBACK_PATH, ACTIVISTAS_CACHE)


def _guardar_estructura_json_locked() -> None:
    """Guarda el caché de estructura y responsables en estructura_local.json (requiere CACHE_LOCK)."""
    _guardar_json_atomico(config.LOCAL_ESTRUCTURA_PATH, ESTRUCTURA_CACHE)


def _guardar_usuarios_json_locked() -> None:
    """Guarda el caché de usuarios en usuarios_local.json (requiere CACHE_LOCK)."""
    _guardar_json_atomico(config.LOCAL_USUARIOS_PATH, USUARIOS_CACHE)


def _estructura_id(rol: str, nombre: str) -> str:
    """Genera un identificador estable sin tildes para Firestore por (rol, nombre)."""
    rol_clean = str(rol or "").strip().lower()
    nombre_key = normalizar_clave_es(nombre)
    digest = hashlib.sha1(f"{rol_clean}|{nombre_key}".encode("utf-8")).hexdigest()[:12]
    return f"{rol_clean}__{digest}"


def _buscar_estructura_por_clave_locked(
    rol: str, nombre: str
) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Busca un responsable por (rol, nombre) tolerando diferencias de tildes."""
    rol_clean = str(rol or "").strip().lower()
    nombre_key = normalizar_clave_es(nombre)
    if not rol_clean or not nombre_key:
        return None
    canon_id = _estructura_id(rol_clean, nombre_key)
    if canon_id in ESTRUCTURA_CACHE:
        return canon_id, ESTRUCTURA_CACHE[canon_id]
    for eid, item in ESTRUCTURA_CACHE.items():
        if (
            item.get("rol") == rol_clean
            and normalizar_clave_es(item.get("nombre")) == nombre_key
        ):
            return eid, item
    return None


def _extraer_sufijo_representante(codigo_planilla: Optional[str]) -> str:
    """Extrae el número de representante (YY) desde un código AP-XX-YY."""
    cod = formatear_codigo_planilla(codigo_planilla)
    match = re.match(r"^AP-\d{2}-(\d{1,4})$", cod)
    if not match:
        return ""
    return normalizar_codigo_representante(match.group(1))


def _asegurar_estructura_item_locked(
    rol: str,
    nombre: str,
    ahora: str,
    cedula: str = "",
    telefono: str = "",
    codigo_municipio: str = "",
    municipio: str = "",
    codigo_representante: str = "",
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

    cod_rep = normalizar_codigo_representante(codigo_representante)

    encontrado = _buscar_estructura_por_clave_locked(rol_clean, nombre_norm)
    if encontrado:
        item_id, existente = encontrado
        if not sobrescribir_meta:
            if cod_rep and not existente.get("codigo_representante"):
                actualizado = dict(existente)
                actualizado["codigo_representante"] = cod_rep
                actualizado["fecha_actualizacion"] = ahora
                ESTRUCTURA_CACHE[item_id] = actualizado
                return dict(actualizado), True
            return dict(existente), False

        actualizado = dict(existente)
        actualizado["nombre"] = nombre_norm
        actualizado["cedula"] = (
            limpiar_cedula(cedula)
            if cedula is not None
            else existente.get("cedula", "")
        )
        actualizado["telefono"] = re.sub(r"\s+", " ", str(telefono or "")).strip()
        actualizado["codigo_municipio"] = cod_mun
        actualizado["municipio"] = nom_mun
        actualizado["codigo_representante"] = cod_rep
        actualizado["fecha_actualizacion"] = ahora
        ESTRUCTURA_CACHE[item_id] = actualizado
        return dict(actualizado), False

    item_id = _estructura_id(rol_clean, nombre_norm)
    nuevo = {
        "id": item_id,
        "rol": rol_clean,
        "nombre": nombre_norm,
        "cedula": limpiar_cedula(cedula) if cedula else "",
        "telefono": re.sub(r"\s+", " ", str(telefono or "")).strip(),
        "codigo_municipio": cod_mun,
        "municipio": nom_mun,
        "codigo_representante": cod_rep,
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
    cod_rep = _extraer_sufijo_representante(activista.get("codigo"))
    tiene_enlace = len(str(activista.get("enlace") or "").strip()) >= 2

    for rol in ROLES_ESTRUCTURA:
        val = str(activista.get(rol) or "").strip()
        if len(val) < 2:
            continue
        if rol == "enlace":
            rep_rol = cod_rep
        elif rol == "responsable_cal" and not tiene_enlace:
            rep_rol = cod_rep
        else:
            rep_rol = ""

        res = _asegurar_estructura_item_locked(
            rol=rol,
            nombre=val,
            ahora=ahora,
            codigo_municipio=cod_mun,
            municipio=nom_mun,
            codigo_representante=rep_rol,
            sobrescribir_meta=False,
        )
        if res and res[1]:
            creados.append(res[0])
    return creados


def _commit_firestore_ops(ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]]) -> None:
    """Ejecuta operaciones Firestore (set/delete) en lotes seguros <= 450 por batch."""
    if not (_MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None and ops):
        return
    chunk_size = 450
    for i in range(0, len(ops), chunk_size):
        batch = _FIRESTORE_DB.batch()
        for op_type, doc_ref, payload in ops[i : i + chunk_size]:
            if op_type == "delete":
                batch.delete(doc_ref)
            else:
                batch.set(doc_ref, payload)
        batch.commit()


def _reparar_codigos_truncados_locked(ahora: str) -> List[Dict[str, Any]]:
    """Repara activistas en caché con código truncado (ej. AP-01) asignándoles correlativo."""
    reparados: List[Dict[str, Any]] = []
    for ced, act in list(ACTIVISTAS_CACHE.items()):
        if _es_codigo_truncado(act.get("codigo")):
            actualizado = dict(act)
            rep_nombre = actualizado.get("enlace") or actualizado.get("responsable_cal")
            actualizado["codigo"] = _calcular_siguiente_codigo_locked(
                actualizado.get("codigo_municipio") or "01",
                representante=rep_nombre,
            )
            actualizado["fecha_actualizacion"] = ahora
            ACTIVISTAS_CACHE[ced] = actualizado
            reparados.append(actualizado)
    return reparados


def _construir_backup_payload_locked() -> Dict[str, Any]:
    activistas = [dict(v) for v in ACTIVISTAS_CACHE.values()]
    estructura = [dict(v) for v in ESTRUCTURA_CACHE.values()]
    activistas.sort(key=lambda x: str(x.get("codigo", "")))
    estructura.sort(key=lambda x: (str(x.get("rol", "")), str(x.get("nombre", ""))))
    return {
        "version": "1.0",
        "fecha_exportacion": datetime.now(timezone.utc).isoformat(),
        "total_activistas": len(activistas),
        "total_estructura": len(estructura),
        "activistas": activistas,
        "estructura": estructura,
    }


def _rotar_backups_automaticos_locked() -> None:
    """Conserva únicamente los últimos MAX_AUTO_BACKUPS respaldos automáticos."""
    if not config.BACKUPS_DIR.exists():
        return
    archivos = [
        p
        for p in config.BACKUPS_DIR.iterdir()
        if p.is_file() and _PATRON_AUTO_BACKUP.match(p.name)
    ]
    archivos.sort(key=lambda p: p.name, reverse=True)
    for viejo in archivos[config.MAX_AUTO_BACKUPS :]:
        try:
            viejo.unlink(missing_ok=True)
        except Exception as exc:
            logger.warning("No se pudo rotar respaldo antiguo %s: %s", viejo.name, exc)


def _crear_respaldo_automatico_locked(motivo: str) -> Optional[Path]:
    """Crea un respaldo automático rotativo en BACKUPS_DIR (requiere CACHE_LOCK)."""
    motivo_clean = re.sub(r"[^a-z0-9_]", "", str(motivo or "auto").lower()) or "auto"
    ahora_dt = datetime.now(timezone.utc)
    fname = f"auto_{ahora_dt.strftime('%Y%m%d_%H%M%S')}_{motivo_clean}.json"
    destino = config.BACKUPS_DIR / fname
    payload = _construir_backup_payload_locked()
    try:
        _guardar_json_atomico(destino, payload)
        _rotar_backups_automaticos_locked()
        return destino
    except Exception as exc:
        logger.warning("No se pudo generar respaldo automático (%s): %s", motivo_clean, exc)
        return None


def _asegurar_backup_diario_locked() -> None:
    """Genera un respaldo automático diario en la primera escritura del día."""
    if not ACTIVISTAS_CACHE and not ESTRUCTURA_CACHE:
        return
    hoy = datetime.now(timezone.utc).strftime("%Y%m%d")
    if config.BACKUPS_DIR.exists():
        prefijo = f"auto_{hoy}_"
        for p in config.BACKUPS_DIR.iterdir():
            if p.is_file() and p.name.startswith(prefijo) and p.name.endswith("_diario.json"):
                return
    _crear_respaldo_automatico_locked("diario")


def listar_backups_automaticos() -> List[Dict[str, Any]]:
    """Lista los respaldos automáticos almacenados localmente ordenados del más reciente al más antiguo."""
    if not config.BACKUPS_DIR.exists():
        return []
    salida: List[Dict[str, Any]] = []
    for p in config.BACKUPS_DIR.iterdir():
        if not p.is_file():
            continue
        m = _PATRON_AUTO_BACKUP.match(p.name)
        if not m:
            continue
        stat = p.stat()
        fecha_raw, hora_raw, motivo = m.group(1), m.group(2), m.group(3)
        try:
            dt = datetime.strptime(f"{fecha_raw}{hora_raw}", "%Y%m%d%H%M%S").replace(
                tzinfo=timezone.utc
            )
            fecha_iso = dt.isoformat()
        except ValueError:
            fecha_iso = ""
        salida.append(
            {
                "filename": p.name,
                "motivo": motivo,
                "fecha_creacion": fecha_iso,
                "size_bytes": stat.st_size,
            }
        )
    salida.sort(key=lambda x: x["filename"], reverse=True)
    return salida


def leer_backup_automatico(filename: str) -> Optional[Path]:
    """Valida el nombre contra path traversal y retorna la ruta del respaldo automático."""
    if not _PATRON_AUTO_BACKUP.fullmatch(str(filename or "")):
        return None
    base = config.BACKUPS_DIR.resolve()
    target = (base / filename).resolve()
    if target.parent != base or not target.is_file():
        return None
    return target


def init_databases() -> None:
    """Inicializa padrón SQLite (si falta), catálogo CNE y carga en memoria activistas, estructura y usuarios."""
    global _FIRESTORE_DB, _MODO_PERSISTENCIA

    padron.cargar_catalogo_padron()
    ahora = datetime.now(timezone.utc).isoformat()

    with CACHE_LOCK:
        ACTIVISTAS_CACHE.clear()
        ESTRUCTURA_CACHE.clear()
        USUARIOS_CACHE.clear()

        if config.FIREBASE_CRED_PATH.exists():
            try:
                import firebase_admin
                from firebase_admin import credentials, firestore

                if not firebase_admin._apps:
                    cred = credentials.Certificate(str(config.FIREBASE_CRED_PATH))
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
                        data["codigo_representante"] = normalizar_codigo_representante(
                            data.get("codigo_representante")
                        )
                        ESTRUCTURA_CACHE[item_id] = data

                for doc in _FIRESTORE_DB.collection("usuarios").stream():
                    data = doc.to_dict() or {}
                    uname = str(data.get("username") or doc.id).strip().lower()
                    if uname and data.get("password_hash"):
                        data["username"] = uname
                        USUARIOS_CACHE[uname] = data

                ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
                reparados = _reparar_codigos_truncados_locked(ahora)
                if reparados:
                    col_act = _FIRESTORE_DB.collection("activistas")
                    for act in reparados:
                        ops.append(("set", col_act.document(act["cedula"]), act))

                if not ESTRUCTURA_CACHE and ACTIVISTAS_CACHE:
                    sembrados: List[Dict[str, Any]] = []
                    for act in ACTIVISTAS_CACHE.values():
                        sembrados.extend(_extraer_estructura_de_activista_locked(act, ahora))
                    if sembrados:
                        col_est = _FIRESTORE_DB.collection("estructura")
                        for item in sembrados:
                            ops.append(("set", col_est.document(item["id"]), item))

                if ops:
                    _commit_firestore_ops(ops)
                logger.info(
                    "Inicializado en modo Firestore: %d activistas, %d estructura, %d usuarios.",
                    len(ACTIVISTAS_CACHE),
                    len(ESTRUCTURA_CACHE),
                    len(USUARIOS_CACHE),
                )
                return
            except Exception as exc:
                logger.warning(
                    "No se pudo inicializar Firestore (%s). Activando Fallback JSON local.",
                    exc,
                )

        # Modo Fallback local en JSON
        _FIRESTORE_DB = None
        _MODO_PERSISTENCIA = "local_json"
        if config.LOCAL_FALLBACK_PATH.exists():
            try:
                with open(config.LOCAL_FALLBACK_PATH, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                if isinstance(raw, dict):
                    for k, v in raw.items():
                        ced = limpiar_cedula((v or {}).get("cedula") or k)
                        if ced and isinstance(v, dict):
                            v["cedula"] = ced
                            ACTIVISTAS_CACHE[ced] = v
            except Exception as exc:
                logger.warning("Error leyendo %s: %s", config.LOCAL_FALLBACK_PATH, exc)

        if config.LOCAL_ESTRUCTURA_PATH.exists():
            try:
                with open(config.LOCAL_ESTRUCTURA_PATH, "r", encoding="utf-8") as f:
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
                            v["codigo_representante"] = normalizar_codigo_representante(
                                v.get("codigo_representante")
                            )
                            ESTRUCTURA_CACHE[item_id] = v
            except Exception as exc:
                logger.warning("Error leyendo %s: %s", config.LOCAL_ESTRUCTURA_PATH, exc)
        elif ACTIVISTAS_CACHE:
            for act in ACTIVISTAS_CACHE.values():
                _extraer_estructura_de_activista_locked(act, ahora)
            if ESTRUCTURA_CACHE:
                _guardar_estructura_json_locked()

        if config.LOCAL_USUARIOS_PATH.exists():
            try:
                with open(config.LOCAL_USUARIOS_PATH, "r", encoding="utf-8") as f:
                    raw_usr = json.load(f)
                if isinstance(raw_usr, dict):
                    for k, v in raw_usr.items():
                        if not isinstance(v, dict):
                            continue
                        uname = str(v.get("username") or k).strip().lower()
                        if uname and v.get("password_hash"):
                            v["username"] = uname
                            USUARIOS_CACHE[uname] = v
            except Exception as exc:
                logger.warning("Error leyendo %s: %s", config.LOCAL_USUARIOS_PATH, exc)

        if _reparar_codigos_truncados_locked(ahora):
            _guardar_fallback_json_locked()

        logger.info(
            "Inicializado en modo local JSON: %d activistas, %d estructura, %d usuarios.",
            len(ACTIVISTAS_CACHE),
            len(ESTRUCTURA_CACHE),
            len(USUARIOS_CACHE),
        )


def obtener_estado_sistema() -> Dict[str, Any]:
    with CACHE_LOCK:
        total = len(ACTIVISTAS_CACHE)
        total_est = len(ESTRUCTURA_CACHE)
        total_usr = len(USUARIOS_CACHE)
    resumen_padron = padron.obtener_resumen_padron()
    return {
        "modo_persistencia": _MODO_PERSISTENCIA,
        "total_activistas": total,
        "total_estructura": total_est,
        "total_usuarios": total_usr,
        **resumen_padron,
    }


def _buscar_codigo_representante_locked(representante: Optional[str]) -> str:
    """Busca el código de representante en ESTRUCTURA_CACHE por nombre (tolerando tildes)."""
    nombre_key = normalizar_clave_es(representante)
    if not nombre_key:
        return ""
    for rol_pref in ("enlace", "responsable_cal", *ROLES_ESTRUCTURA):
        encontrado = _buscar_estructura_por_clave_locked(rol_pref, nombre_key)
        if encontrado:
            _, item = encontrado
            cod_rep = normalizar_codigo_representante(item.get("codigo_representante"))
            if cod_rep:
                return cod_rep
    return ""


def _calcular_siguiente_codigo_locked(
    codigo_municipio: str, representante: Optional[str] = None
) -> str:
    """Arma AP-XX-YY usando el código del representante o el siguiente correlativo (requiere CACHE_LOCK)."""
    cod_mun = str(codigo_municipio or "01").strip().zfill(2)
    if representante:
        cod_rep = _buscar_codigo_representante_locked(representante)
        if cod_rep:
            return f"AP-{cod_mun}-{cod_rep}"
    prefijo = f"AP-{cod_mun}-"
    max_num = 0
    for item in ACTIVISTAS_CACHE.values():
        c = str(item.get("codigo") or "").strip().upper()
        if c.startswith(prefijo) and c[len(prefijo) :].isdigit():
            max_num = max(max_num, int(c[len(prefijo) :]))
    return f"{prefijo}{max_num + 1:02d}"


def generar_codigo_planilla(
    codigo_municipio: str, representante: Optional[str] = None
) -> str:
    """Genera el código formato AP-{MUNICIPIO}-{REPRESENTANTE} (ej. AP-01-01) usando el caché."""
    with CACHE_LOCK:
        return _calcular_siguiente_codigo_locked(codigo_municipio, representante=representante)


def obtener_activista_cache(cedula: str) -> Optional[Dict[str, Any]]:
    ced = limpiar_cedula(cedula)
    with CACHE_LOCK:
        item = ACTIVISTAS_CACHE.get(ced)
        return dict(item) if item else None


def _preparar_activista_locked(
    datos: Dict[str, Any],
    ahora: str,
    codigo_lote: Optional[str] = None,
    actor: str = "admin",
) -> Dict[str, Any]:
    """Normaliza geografía, estructura, código y fechas de un activista antes de persistir (requiere CACHE_LOCK)."""
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

    # Unificar nombres de responsables con el canónico en ESTRUCTURA_CACHE si ya existe sin tilde
    for rol in ROLES_ESTRUCTURA:
        val = str(datos.get(rol) or "").strip()
        if len(val) >= 2:
            encontrado = _buscar_estructura_por_clave_locked(rol, val)
            if encontrado:
                datos[rol] = encontrado[1]["nombre"]

    existente = ACTIVISTAS_CACHE.get(ced)
    cod_ingresado = formatear_codigo_planilla(datos.get("codigo"))
    if _es_codigo_truncado(cod_ingresado):
        rep_nombre = datos.get("enlace") or datos.get("responsable_cal")
        if existente and not _es_codigo_truncado(existente.get("codigo")):
            datos["codigo"] = formatear_codigo_planilla(existente["codigo"])
        elif codigo_lote and not _es_codigo_truncado(codigo_lote):
            datos["codigo"] = formatear_codigo_planilla(codigo_lote)
        else:
            datos["codigo"] = _calcular_siguiente_codigo_locked(
                datos.get("codigo_municipio") or "01",
                representante=rep_nombre,
            )
    else:
        datos["codigo"] = cod_ingresado

    datos["fecha_registro"] = (
        existente.get("fecha_registro", ahora) if existente else ahora
    )
    datos["fecha_actualizacion"] = ahora
    datos["creado_por"] = (
        (existente.get("creado_por") if existente else None)
        or datos.get("creado_por")
        or actor
    )
    datos["actualizado_por"] = actor
    return datos


def _persistir_cambios_locked(
    ops_firestore: List[Tuple[str, Any, Optional[Dict[str, Any]]]],
    save_act: bool,
    save_est: bool,
    save_usr: bool = False,
) -> None:
    """Ejecuta escritura en Firestore o disco; el caller es responsable del rollback ante error."""
    if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
        _commit_firestore_ops(ops_firestore)
    else:
        if save_act:
            _guardar_fallback_json_locked()
        if save_est:
            _guardar_estructura_json_locked()
        if save_usr:
            _guardar_usuarios_json_locked()


def guardar_activista_db(datos: Dict[str, Any], actor: str = "admin") -> Dict[str, Any]:
    """Guarda o actualiza un activista en Firestore (o Fallback JSON) con rollback seguro."""
    ahora = datetime.now(timezone.utc).isoformat()

    with CACHE_LOCK:
        _asegurar_backup_diario_locked()
        prev_act = dict(ACTIVISTAS_CACHE)
        prev_est = dict(ESTRUCTURA_CACHE)
        try:
            preparado = _preparar_activista_locked(datos, ahora, actor=actor)
            ced = preparado["cedula"]
            nuevos_est = _extraer_estructura_de_activista_locked(preparado, ahora)
            ACTIVISTAS_CACHE[ced] = dict(preparado)

            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                ops.append(("set", _FIRESTORE_DB.collection("activistas").document(ced), preparado))
                col_est = _FIRESTORE_DB.collection("estructura")
                for est_item in nuevos_est:
                    ops.append(("set", col_est.document(est_item["id"]), est_item))

            _persistir_cambios_locked(ops, save_act=True, save_est=bool(nuevos_est))
            return dict(preparado)
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            ESTRUCTURA_CACHE.clear()
            ESTRUCTURA_CACHE.update(prev_est)
            raise


def guardar_activistas_lote_db(
    lista_datos: List[Dict[str, Any]], actor: str = "admin"
) -> Dict[str, Any]:
    """Guarda o actualiza múltiples activistas de una planilla en un solo lote con rollback seguro."""
    ahora = datetime.now(timezone.utc).isoformat()
    guardados: List[Dict[str, Any]] = []
    nuevos = 0
    actualizados = 0

    with CACHE_LOCK:
        _asegurar_backup_diario_locked()
        prev_act = dict(ACTIVISTAS_CACHE)
        prev_est = dict(ESTRUCTURA_CACHE)
        try:
            codigo_fallback = None
            for d in lista_datos:
                cand = formatear_codigo_planilla(d.get("codigo"))
                if not _es_codigo_truncado(cand):
                    codigo_fallback = cand
                    break
            if not codigo_fallback and lista_datos:
                rep_lote = lista_datos[0].get("enlace") or lista_datos[0].get("responsable_cal")
                codigo_fallback = _calcular_siguiente_codigo_locked(
                    lista_datos[0].get("codigo_municipio") or "01",
                    representante=rep_lote,
                )

            preparados_por_ced: Dict[str, Dict[str, Any]] = {}
            nuevos_est_por_id: Dict[str, Dict[str, Any]] = {}
            for d in lista_datos:
                preparado = _preparar_activista_locked(
                    d, ahora, codigo_lote=codigo_fallback, actor=actor
                )
                ced = preparado["cedula"]
                if ced in ACTIVISTAS_CACHE or ced in preparados_por_ced:
                    actualizados += 1
                else:
                    nuevos += 1
                preparados_por_ced[ced] = preparado
                for est_item in _extraer_estructura_de_activista_locked(preparado, ahora):
                    nuevos_est_por_id[est_item["id"]] = est_item

            for ced, item in preparados_por_ced.items():
                ACTIVISTAS_CACHE[ced] = dict(item)
                guardados.append(dict(item))

            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                col_act = _FIRESTORE_DB.collection("activistas")
                col_est = _FIRESTORE_DB.collection("estructura")
                ops = [
                    ("set", col_act.document(ced), item)
                    for ced, item in preparados_por_ced.items()
                ]
                for eid, est_item in nuevos_est_por_id.items():
                    ops.append(("set", col_est.document(eid), est_item))

            _persistir_cambios_locked(
                ops, save_act=True, save_est=bool(nuevos_est_por_id)
            )
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            ESTRUCTURA_CACHE.clear()
            ESTRUCTURA_CACHE.update(prev_est)
            raise

    return {
        "total_procesados": len(guardados),
        "nuevos": nuevos,
        "actualizados": actualizados,
        "codigo_planilla": codigo_fallback or "",
        "activistas": guardados,
    }


def actualizar_activistas_masivo_db(
    cedulas: List[str], cambios: Dict[str, Any], actor: str = "admin"
) -> Dict[str, Any]:
    """Actualiza en bloque campos comunes de múltiples activistas con rollback seguro."""
    ahora = datetime.now(timezone.utc).isoformat()
    campos_validos = {
        k: v
        for k, v in cambios.items()
        if v is not None and not (k == "codigo" and _es_codigo_truncado(v))
    }
    if not campos_validos:
        return {"actualizados": 0, "activistas": []}

    with CACHE_LOCK:
        _asegurar_backup_diario_locked()
        prev_act = dict(ACTIVISTAS_CACHE)
        prev_est = dict(ESTRUCTURA_CACHE)
        try:
            modificados: Dict[str, Dict[str, Any]] = {}
            nuevos_est_por_id: Dict[str, Dict[str, Any]] = {}

            for raw_ced in cedulas:
                ced = limpiar_cedula(raw_ced)
                existente = ACTIVISTAS_CACHE.get(ced)
                if not existente:
                    continue
                actualizado = dict(existente)
                for k, v in campos_validos.items():
                    if k in ROLES_ESTRUCTURA and isinstance(v, str) and len(v) >= 2:
                        enc = _buscar_estructura_por_clave_locked(k, v)
                        actualizado[k] = enc[1]["nombre"] if enc else v
                    else:
                        actualizado[k] = v
                actualizado["fecha_actualizacion"] = ahora
                actualizado["actualizado_por"] = actor
                ACTIVISTAS_CACHE[ced] = actualizado
                modificados[ced] = actualizado
                for est_item in _extraer_estructura_de_activista_locked(actualizado, ahora):
                    nuevos_est_por_id[est_item["id"]] = est_item

            if not modificados:
                return {"actualizados": 0, "activistas": []}

            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                col_act = _FIRESTORE_DB.collection("activistas")
                col_est = _FIRESTORE_DB.collection("estructura")
                for ced, act_item in modificados.items():
                    ops.append(("set", col_act.document(ced), act_item))
                for eid, est_item in nuevos_est_por_id.items():
                    ops.append(("set", col_est.document(eid), est_item))

            _persistir_cambios_locked(
                ops, save_act=True, save_est=bool(nuevos_est_por_id)
            )
            return {
                "actualizados": len(modificados),
                "activistas": [dict(v) for v in modificados.values()],
            }
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            ESTRUCTURA_CACHE.clear()
            ESTRUCTURA_CACHE.update(prev_est)
            raise


def eliminar_activista_db(cedula: str) -> bool:
    """Elimina un activista de Firestore (o Fallback JSON) y del caché con rollback seguro."""
    ced = limpiar_cedula(cedula)
    with CACHE_LOCK:
        if ced not in ACTIVISTAS_CACHE:
            return False
        prev_act = dict(ACTIVISTAS_CACHE)
        try:
            ACTIVISTAS_CACHE.pop(ced, None)
            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                ops.append(("delete", _FIRESTORE_DB.collection("activistas").document(ced), None))
            _persistir_cambios_locked(ops, save_act=True, save_est=False)
            return True
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            raise


def eliminar_activistas_masivo_db(cedulas: List[str]) -> Dict[str, Any]:
    """Elimina en bloque activistas seleccionados generando antes un respaldo automático."""
    with CACHE_LOCK:
        encontradas = [limpiar_cedula(c) for c in cedulas if limpiar_cedula(c) in ACTIVISTAS_CACHE]
        no_encontradas = len(cedulas) - len(encontradas)
        if not encontradas:
            return {"eliminados": 0, "no_encontrados": no_encontradas}

        _crear_respaldo_automatico_locked("pre_bulk_delete")
        prev_act = dict(ACTIVISTAS_CACHE)
        try:
            for ced in encontradas:
                ACTIVISTAS_CACHE.pop(ced, None)
            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                col_act = _FIRESTORE_DB.collection("activistas")
                for ced in encontradas:
                    ops.append(("delete", col_act.document(ced), None))
            _persistir_cambios_locked(ops, save_act=True, save_est=False)
            return {"eliminados": len(encontradas), "no_encontrados": no_encontradas}
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            raise


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
    """Guarda o actualiza un responsable de estructura con cascada y rollback seguro."""
    ahora = datetime.now(timezone.utc).isoformat()
    id_anterior = str(datos.get("id_anterior") or "").strip()

    with CACHE_LOCK:
        prev_act = dict(ACTIVISTAS_CACHE)
        prev_est = dict(ESTRUCTURA_CACHE)
        try:
            prev_item = (
                dict(ESTRUCTURA_CACHE[id_anterior])
                if id_anterior and id_anterior in ESTRUCTURA_CACHE
                else None
            )
            res = _asegurar_estructura_item_locked(
                rol=str(datos.get("rol") or ""),
                nombre=str(datos.get("nombre") or ""),
                ahora=ahora,
                cedula=str(datos.get("cedula") or ""),
                telefono=str(datos.get("telefono") or ""),
                codigo_municipio=str(datos.get("codigo_municipio") or ""),
                municipio=str(datos.get("municipio") or ""),
                codigo_representante=str(datos.get("codigo_representante") or ""),
                sobrescribir_meta=True,
            )
            if not res:
                raise ValueError("Rol o nombre inválido para estructura.")
            item, creado = res

            activistas_modificados: List[Dict[str, Any]] = []
            eliminar_anterior = bool(prev_item and item["id"] != id_anterior)

            if eliminar_anterior and prev_item is not None:
                rol_viejo = prev_item["rol"]
                nombre_viejo_key = normalizar_clave_es(prev_item["nombre"])
                ESTRUCTURA_CACHE.pop(id_anterior, None)

                for ced, act in list(ACTIVISTAS_CACHE.items()):
                    if normalizar_clave_es(act.get(rol_viejo)) == nombre_viejo_key:
                        actualizado = dict(act)
                        if rol_viejo == item["rol"]:
                            actualizado[rol_viejo] = item["nombre"]
                        else:
                            actualizado[rol_viejo] = ""
                            actualizado[item["rol"]] = item["nombre"]
                        actualizado["fecha_actualizacion"] = ahora
                        ACTIVISTAS_CACHE[ced] = actualizado
                        activistas_modificados.append(actualizado)

            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                col_est = _FIRESTORE_DB.collection("estructura")
                col_act = _FIRESTORE_DB.collection("activistas")
                ops.append(("set", col_est.document(item["id"]), item))
                if eliminar_anterior:
                    ops.append(("delete", col_est.document(id_anterior), None))
                for act in activistas_modificados:
                    ops.append(("set", col_act.document(act["cedula"]), act))

            _persistir_cambios_locked(
                ops, save_act=bool(activistas_modificados), save_est=True
            )
            return {
                "item": item,
                "creado": creado,
                "activistas_actualizados": len(activistas_modificados),
            }
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            ESTRUCTURA_CACHE.clear()
            ESTRUCTURA_CACHE.update(prev_est)
            raise


def eliminar_estructura_db(item_id: str) -> Dict[str, Any]:
    """Elimina un responsable de estructura y limpia referencias huérfanas con rollback seguro."""
    clean_id = str(item_id or "").strip()
    ahora = datetime.now(timezone.utc).isoformat()
    with CACHE_LOCK:
        if clean_id not in ESTRUCTURA_CACHE:
            return {"eliminado": False, "activistas_actualizados": 0}

        prev_act = dict(ACTIVISTAS_CACHE)
        prev_est = dict(ESTRUCTURA_CACHE)
        try:
            prev_item = ESTRUCTURA_CACHE.pop(clean_id)
            rol_viejo = prev_item["rol"]
            nombre_viejo_key = normalizar_clave_es(prev_item["nombre"])
            activistas_modificados: List[Dict[str, Any]] = []

            for ced, act in list(ACTIVISTAS_CACHE.items()):
                if normalizar_clave_es(act.get(rol_viejo)) == nombre_viejo_key:
                    actualizado = dict(act)
                    actualizado[rol_viejo] = ""
                    actualizado["fecha_actualizacion"] = ahora
                    ACTIVISTAS_CACHE[ced] = actualizado
                    activistas_modificados.append(actualizado)

            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                col_est = _FIRESTORE_DB.collection("estructura")
                col_act = _FIRESTORE_DB.collection("activistas")
                ops.append(("delete", col_est.document(clean_id), None))
                for act in activistas_modificados:
                    ops.append(("set", col_act.document(act["cedula"]), act))

            _persistir_cambios_locked(
                ops, save_act=bool(activistas_modificados), save_est=True
            )
            return {
                "eliminado": True,
                "activistas_actualizados": len(activistas_modificados),
            }
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            ESTRUCTURA_CACHE.clear()
            ESTRUCTURA_CACHE.update(prev_est)
            raise


def filtrar_activistas(
    cedula: Optional[str] = None,
    nombre: Optional[str] = None,
    codigo: Optional[str] = None,
    codigo_municipio: Optional[str] = None,
    codigo_parroquia: Optional[str] = None,
    centro_votacion: Optional[str] = None,
    cal: Optional[str] = None,
    enlace: Optional[str] = None,
    responsable_cal: Optional[str] = None,
    responsable_local: Optional[str] = None,
    responsable_comunidad: Optional[str] = None,
    responsable_municipal: Optional[str] = None,
    comunidad: Optional[str] = None,
    rol_electoral: Optional[str] = None,
    estado_contacto: Optional[str] = None,
    creado_por: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Ejecuta búsqueda por cédula/nombre y filtros combinables 100% sobre el caché en memoria."""
    ced_q = limpiar_cedula(cedula) if cedula else ""
    nombre_q = normalizar_texto(nombre)
    cod_q = normalizar_texto(codigo)
    mun_q = (
        str(codigo_municipio).strip().zfill(2)
        if codigo_municipio and str(codigo_municipio).strip()
        else ""
    )
    par_q = (
        str(codigo_parroquia).strip().zfill(2)
        if codigo_parroquia and str(codigo_parroquia).strip()
        else ""
    )
    centro_q = normalizar_texto(centro_votacion)
    cal_q = normalizar_texto(cal)
    enlace_q = normalizar_texto(enlace)
    resp_cal_q = normalizar_texto(responsable_cal)
    resp_loc_q = normalizar_texto(responsable_local)
    resp_com_q = normalizar_texto(responsable_comunidad)
    resp_mun_q = normalizar_texto(responsable_municipal)
    comunidad_q = normalizar_texto(comunidad)
    rol_el_q = normalizar_texto(rol_electoral)
    est_con_q = normalizar_texto(estado_contacto)
    autor_q = str(creado_por or "").strip().lower()

    with CACHE_LOCK:
        registros = list(ACTIVISTAS_CACHE.values())

    resultados: List[Dict[str, Any]] = []
    for r in registros:
        if autor_q and str(r.get("creado_por") or "").strip().lower() != autor_q:
            continue
        if ced_q and ced_q not in str(r.get("cedula", "")):
            continue
        if nombre_q and nombre_q not in normalizar_texto(r.get("nombre_apellido", "")):
            continue
        if cod_q and cod_q not in normalizar_texto(r.get("codigo", "")):
            continue
        if mun_q and str(r.get("codigo_municipio", "")).zfill(2) != mun_q:
            continue
        if par_q and str(r.get("codigo_parroquia", "")).zfill(2) != par_q:
            continue
        if centro_q and centro_q not in normalizar_texto(r.get("centro_votacion", "")):
            continue
        if cal_q and cal_q not in normalizar_texto(r.get("comite_activismo_local", "")):
            continue
        if enlace_q and enlace_q not in normalizar_texto(r.get("enlace", "")):
            continue
        if resp_cal_q and resp_cal_q not in normalizar_texto(r.get("responsable_cal", "")):
            continue
        if resp_loc_q and resp_loc_q not in normalizar_texto(r.get("responsable_local", "")):
            continue
        if resp_com_q and resp_com_q not in normalizar_texto(r.get("responsable_comunidad", "")):
            continue
        if resp_mun_q and resp_mun_q not in normalizar_texto(r.get("responsable_municipal", "")):
            continue
        if comunidad_q and comunidad_q not in normalizar_texto(r.get("comunidad", "")):
            continue
        if rol_el_q and normalizar_texto(r.get("rol_electoral", "")) != rol_el_q:
            continue
        if est_con_q and normalizar_texto(r.get("estado_contacto", "")) != est_con_q:
            continue
        resultados.append(dict(r))

    resultados.sort(key=lambda x: str(x.get("codigo", "")))
    return resultados


def listar_planillas_resumen(creado_por: Optional[str] = None) -> List[Dict[str, Any]]:
    """Agrupa activistas por código de planilla AP-XX-YY (100% en memoria)."""
    autor_q = str(creado_por or "").strip().lower()
    with CACHE_LOCK:
        registros = list(ACTIVISTAS_CACHE.values())

    grupos: Dict[str, Dict[str, Any]] = {}
    for r in registros:
        if autor_q and str(r.get("creado_por") or "").strip().lower() != autor_q:
            continue
        cod = str(r.get("codigo") or "").strip().upper() or "SIN CÓDIGO"
        grp = grupos.get(cod)
        fecha = str(r.get("fecha_actualizacion") or r.get("fecha_registro") or "")
        if not grp:
            grupos[cod] = {
                "codigo": cod,
                "total": 0,
                "codigo_municipio": str(r.get("codigo_municipio") or ""),
                "municipio": str(r.get("municipio") or ""),
                "codigo_parroquia": str(r.get("codigo_parroquia") or ""),
                "parroquia": str(r.get("parroquia") or ""),
                "comunidad": str(r.get("comunidad") or ""),
                "comite_activismo_local": str(r.get("comite_activismo_local") or ""),
                "enlace": str(r.get("enlace") or ""),
                "responsable_cal": str(r.get("responsable_cal") or ""),
                "responsable_local": str(r.get("responsable_local") or ""),
                "responsable_comunidad": str(r.get("responsable_comunidad") or ""),
                "responsable_municipal": str(r.get("responsable_municipal") or ""),
                "ultima_actualizacion": fecha,
                "cedulas": [],
            }
            grp = grupos[cod]
        grp["total"] += 1
        grp["cedulas"].append(r.get("cedula", ""))
        if fecha > grp["ultima_actualizacion"]:
            grp["ultima_actualizacion"] = fecha
        for campo in (
            "comunidad",
            "comite_activismo_local",
            "enlace",
            "responsable_cal",
            "responsable_local",
            "responsable_comunidad",
            "responsable_municipal",
        ):
            if not grp[campo] and r.get(campo):
                grp[campo] = str(r[campo])

    salida = list(grupos.values())
    salida.sort(key=lambda g: g["codigo"])
    return salida


def _construir_desglose_canonico(
    conteo_por_clave: Counter,
    etiquetas_por_clave: Dict[str, Counter],
    total: int,
) -> List[Dict[str, Any]]:
    if total == 0:
        return []
    salida = []
    for clave, cantidad in conteo_por_clave.most_common():
        etiqueta = etiquetas_por_clave[clave].most_common(1)[0][0]
        porcentaje = round((cantidad * 100.0) / total, 2)
        salida.append(
            {
                "etiqueta": etiqueta,
                "cantidad": cantidad,
                "porcentaje": porcentaje,
            }
        )
    return salida


def _calcular_rango_etario(fecha_nacimiento: Optional[str]) -> str:
    raw = str(fecha_nacimiento or "").strip()
    if len(raw) < 4:
        return "SIN DATO"
    try:
        if len(raw) >= 10:
            nac = date.fromisoformat(raw[:10])
            hoy = datetime.now(timezone.utc).date()
            edad = hoy.year - nac.year - ((hoy.month, hoy.day) < (nac.month, nac.day))
        else:
            edad = datetime.now(timezone.utc).year - int(raw[:4])
    except ValueError:
        return "SIN DATO"

    if edad < 18 or edad > 120:
        return "SIN DATO"
    if edad <= 25:
        return "18-25"
    if edad <= 35:
        return "26-35"
    if edad <= 50:
        return "36-50"
    if edad <= 65:
        return "51-65"
    return "65+"


def calcular_estadisticas(
    codigo_municipio: str = "", codigo_parroquia: str = ""
) -> Dict[str, Any]:
    """Calcula conteos y porcentajes exactos sin fragmentar por tildes (Cuota Cero)."""
    mun_q = str(codigo_municipio or "").strip().zfill(2) if codigo_municipio else ""
    par_q = str(codigo_parroquia or "").strip().zfill(2) if codigo_parroquia else ""

    with CACHE_LOCK:
        registros = list(ACTIVISTAS_CACHE.values())

    if mun_q or par_q:
        registros = [
            r
            for r in registros
            if (not mun_q or str(r.get("codigo_municipio", "")).zfill(2) == mun_q)
            and (not par_q or str(r.get("codigo_parroquia", "")).zfill(2) == par_q)
        ]

    total = len(registros)
    c_centro: Counter = Counter()
    e_centro: Dict[str, Counter] = defaultdict(Counter)
    c_parroquia: Counter = Counter()
    e_parroquia: Dict[str, Counter] = defaultdict(Counter)
    c_municipio: Counter = Counter()
    e_municipio: Dict[str, Counter] = defaultdict(Counter)
    c_comunidad: Counter = Counter()
    e_comunidad: Dict[str, Counter] = defaultdict(Counter)
    c_resp_mun: Counter = Counter()
    e_resp_mun: Dict[str, Counter] = defaultdict(Counter)
    c_resp_cal: Counter = Counter()
    e_resp_cal: Dict[str, Counter] = defaultdict(Counter)
    c_sexo: Counter = Counter()
    e_sexo: Dict[str, Counter] = defaultdict(Counter)
    c_edad: Counter = Counter()
    e_edad: Dict[str, Counter] = defaultdict(Counter)
    c_rol_el: Counter = Counter()
    e_rol_el: Dict[str, Counter] = defaultdict(Counter)
    c_est_con: Counter = Counter()
    e_est_con: Dict[str, Counter] = defaultdict(Counter)

    def _add(counter: Counter, labels: Dict[str, Counter], val: str) -> None:
        display = str(val or "").strip() or "SIN ESPECIFICAR"
        clave = normalizar_clave_es(display) or "SIN ESPECIFICAR"
        counter[clave] += 1
        labels[clave][display] += 1

    for r in registros:
        centro = str(r.get("centro_votacion") or "").strip() or "SIN ESPECIFICAR"
        mun = str(r.get("municipio") or "").strip() or "SIN ESPECIFICAR"
        par = str(r.get("parroquia") or "").strip() or "SIN ESPECIFICAR"
        par_label = f"{par} ({mun})" if mun != "SIN ESPECIFICAR" else par
        com = str(r.get("comunidad") or "").strip() or "SIN ESPECIFICAR"
        rmun = str(r.get("responsable_municipal") or "").strip() or "SIN ESPECIFICAR"
        rcal = str(r.get("responsable_cal") or "").strip() or "SIN ESPECIFICAR"

        sexo_raw = str(r.get("sexo") or "").strip().upper()
        sexo_lbl = (
            "Hombre (H)"
            if sexo_raw == "H"
            else ("Mujer (M)" if sexo_raw == "M" else "SIN ESPECIFICAR")
        )
        rango_edad = _calcular_rango_etario(r.get("fecha_nacimiento"))
        rol_el = str(r.get("rol_electoral") or "").strip() or "MILITANTE / GENERAL"
        est_con = str(r.get("estado_contacto") or "").strip() or "SIN VERIFICAR"

        _add(c_centro, e_centro, centro)
        _add(c_parroquia, e_parroquia, par_label)
        _add(c_municipio, e_municipio, mun)
        _add(c_comunidad, e_comunidad, com)
        _add(c_resp_mun, e_resp_mun, rmun)
        _add(c_resp_cal, e_resp_cal, rcal)
        _add(c_sexo, e_sexo, sexo_lbl)
        _add(c_edad, e_edad, rango_edad)
        _add(c_rol_el, e_rol_el, rol_el)
        _add(c_est_con, e_est_con, est_con)

    return {
        "total_registrados": total,
        "por_centro_votacion": _construir_desglose_canonico(c_centro, e_centro, total),
        "por_parroquia": _construir_desglose_canonico(c_parroquia, e_parroquia, total),
        "por_municipio": _construir_desglose_canonico(c_municipio, e_municipio, total),
        "por_comunidad": _construir_desglose_canonico(c_comunidad, e_comunidad, total),
        "por_responsable_municipal": _construir_desglose_canonico(c_resp_mun, e_resp_mun, total),
        "por_responsable_cal": _construir_desglose_canonico(c_resp_cal, e_resp_cal, total),
        "por_sexo": _construir_desglose_canonico(c_sexo, e_sexo, total),
        "por_rango_etario": _construir_desglose_canonico(c_edad, e_edad, total),
        "por_rol_electoral": _construir_desglose_canonico(c_rol_el, e_rol_el, total),
        "por_estado_contacto": _construir_desglose_canonico(c_est_con, e_est_con, total),
    }


def calcular_cobertura_cne(
    codigo_municipio: str = "", codigo_parroquia: str = ""
) -> Dict[str, Any]:
    """Cruza activistas en caché contra los centros reales del padrón CNE (100% en memoria)."""
    mun_q = str(codigo_municipio or "").strip().zfill(2) if codigo_municipio else ""
    par_q = str(codigo_parroquia or "").strip().zfill(2) if codigo_parroquia else ""

    centros = padron.listar_centros_cne(
        codigo_municipio=mun_q, codigo_parroquia=par_q, limit=700
    )

    with CACHE_LOCK:
        registros = list(ACTIVISTAS_CACHE.values())

    known_cod_centros = {c["cod_centro"] for c in centros if c.get("cod_centro")}
    cnt_por_cod: Counter = Counter()
    cnt_por_nombre: Counter = Counter()

    for r in registros:
        cod_c = str(r.get("cod_centro") or "").strip()
        if cod_c and cod_c in known_cod_centros:
            cnt_por_cod[cod_c] += 1
        else:
            r_mun = str(r.get("codigo_municipio") or "").strip().zfill(2)
            r_nom = normalizar_clave_es(r.get("centro_votacion"))
            if r_mun and r_nom:
                cnt_por_nombre[(r_mun, r_nom)] += 1

    cubiertos_list: List[Dict[str, Any]] = []
    sin_cobertura_list: List[Dict[str, Any]] = []
    mun_stats: Dict[str, Dict[str, Any]] = {}
    for m in CATALOGO_GEOGRAFICO:
        if mun_q and m["codigo"] != mun_q:
            continue
        mun_stats[m["codigo"]] = {
            "codigo_municipio": m["codigo"],
            "municipio": m["nombre"],
            "total_centros": 0,
            "cubiertos": 0,
            "sin_cobertura": 0,
            "porcentaje_cobertura": 0.0,
            "electores_padron": 0,
            "activistas": 0,
        }

    total_electores_univ = 0
    electores_cubiertos = 0

    for c in centros:
        cod_c = c.get("cod_centro") or ""
        cm = c.get("codigo_municipio") or ""
        nom_key = normalizar_clave_es(c.get("centro_votacion"))
        act_cnt = cnt_por_cod.get(cod_c, 0) if cod_c else 0
        if not act_cnt and cm and nom_key:
            act_cnt = cnt_por_nombre.get((cm, nom_key), 0)

        elec = int(c.get("electores_padron") or 0)
        total_electores_univ += elec
        entry = {**c, "activistas": act_cnt}

        if cm in mun_stats:
            mun_stats[cm]["total_centros"] += 1
            mun_stats[cm]["electores_padron"] += elec
            mun_stats[cm]["activistas"] += act_cnt

        if act_cnt > 0:
            electores_cubiertos += elec
            cubiertos_list.append(entry)
            if cm in mun_stats:
                mun_stats[cm]["cubiertos"] += 1
        else:
            sin_cobertura_list.append(entry)
            if cm in mun_stats:
                mun_stats[cm]["sin_cobertura"] += 1

    for st in mun_stats.values():
        tc = st["total_centros"]
        st["porcentaje_cobertura"] = round((st["cubiertos"] * 100.0) / tc, 2) if tc else 0.0

    sin_cobertura_list.sort(
        key=lambda x: (-int(x.get("electores_padron") or 0), x.get("centro_votacion", ""))
    )
    cubiertos_list.sort(
        key=lambda x: (-int(x.get("activistas") or 0), -int(x.get("electores_padron") or 0))
    )

    total_centros = len(centros)
    total_cubiertos = len(cubiertos_list)
    return {
        "total_centros_cne": total_centros,
        "centros_cubiertos": total_cubiertos,
        "centros_sin_cobertura": len(sin_cobertura_list),
        "porcentaje_cobertura": (
            round((total_cubiertos * 100.0) / total_centros, 2) if total_centros else 0.0
        ),
        "electores_padron_universo": total_electores_univ,
        "electores_en_centros_cubiertos": electores_cubiertos,
        "porcentaje_electores_cubiertos": (
            round((electores_cubiertos * 100.0) / total_electores_univ, 2)
            if total_electores_univ
            else 0.0
        ),
        "por_municipio": sorted(mun_stats.values(), key=lambda x: x["codigo_municipio"]),
        "lista_sin_cobertura": sin_cobertura_list,
        "lista_cubiertos": cubiertos_list,
    }


def analizar_calidad_datos() -> Dict[str, Any]:
    """Detecta brechas de calidad en los activistas cargados (100% en memoria)."""
    with CACHE_LOCK:
        registros = [dict(r) for r in ACTIVISTAS_CACHE.values()]

    total = len(registros)
    if total == 0:
        return {
            "total_registros": 0,
            "score_completitud": 100.0,
            "resumen": {
                "sin_telefono": 0,
                "telefonos_duplicados": 0,
                "sin_centro_votacion": 0,
                "sin_cal": 0,
                "sin_responsable_cal": 0,
                "votan_en_otro_municipio": 0,
            },
            "detalles": {
                "sin_telefono": [],
                "telefonos_duplicados": [],
                "sin_centro_votacion": [],
                "sin_cal": [],
                "sin_responsable_cal": [],
                "votan_en_otro_municipio": [],
            },
        }

    campos_clave = (
        "telefono",
        "centro_votacion",
        "comunidad",
        "comite_activismo_local",
        "responsable_cal",
        "sexo",
    )
    campos_presentes = 0
    sin_telefono: List[Dict[str, Any]] = []
    sin_centro: List[Dict[str, Any]] = []
    sin_cal: List[Dict[str, Any]] = []
    sin_resp_cal: List[Dict[str, Any]] = []
    otro_mun: List[Dict[str, Any]] = []
    por_telefono: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    def _brief(r: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "cedula": r.get("cedula", ""),
            "codigo": r.get("codigo", ""),
            "nombre_apellido": r.get("nombre_apellido", ""),
            "municipio": r.get("municipio", ""),
            "telefono": r.get("telefono", ""),
        }

    for r in registros:
        for campo in campos_clave:
            if str(r.get(campo) or "").strip():
                campos_presentes += 1

        tel = str(r.get("telefono") or "").strip()
        if not tel:
            sin_telefono.append(_brief(r))
        else:
            por_telefono[tel].append(_brief(r))

        if not str(r.get("centro_votacion") or "").strip():
            sin_centro.append(_brief(r))
        if not str(r.get("comite_activismo_local") or "").strip():
            sin_cal.append(_brief(r))
        if not str(r.get("responsable_cal") or "").strip():
            sin_resp_cal.append(_brief(r))

        cod = str(r.get("codigo") or "").strip().upper()
        cod_mun = str(r.get("codigo_municipio") or "").strip().zfill(2)
        m_cod = re.match(r"^AP-(\d{2})-", cod)
        if m_cod and cod_mun and m_cod.group(1) != cod_mun:
            otro_mun.append(
                {
                    **_brief(r),
                    "municipio_planilla": m_cod.group(1),
                    "codigo_municipio": cod_mun,
                }
            )

    duplicados = [
        {
            "telefono": tel,
            "cantidad": len(lista),
            "activistas": lista[:20],
        }
        for tel, lista in sorted(
            por_telefono.items(), key=lambda kv: (-len(kv[1]), kv[0])
        )
        if len(lista) > 1
    ]

    score = round((campos_presentes * 100.0) / (total * len(campos_clave)), 1)
    cap = 200
    return {
        "total_registros": total,
        "score_completitud": score,
        "resumen": {
            "sin_telefono": len(sin_telefono),
            "telefonos_duplicados": len(duplicados),
            "sin_centro_votacion": len(sin_centro),
            "sin_cal": len(sin_cal),
            "sin_responsable_cal": len(sin_resp_cal),
            "votan_en_otro_municipio": len(otro_mun),
        },
        "detalles": {
            "sin_telefono": sin_telefono[:cap],
            "telefonos_duplicados": duplicados[:cap],
            "sin_centro_votacion": sin_centro[:cap],
            "sin_cal": sin_cal[:cap],
            "sin_responsable_cal": sin_resp_cal[:cap],
            "votan_en_otro_municipio": otro_mun[:cap],
        },
    }


def exportar_backup_db() -> Dict[str, Any]:
    """Exporta un respaldo completo en memoria de activistas y estructura (Cuota Cero)."""
    with CACHE_LOCK:
        return _construir_backup_payload_locked()


def restaurar_backup_db(
    activistas_list: List[Dict[str, Any]],
    estructura_list: List[Dict[str, Any]],
    modo: str = "fusionar",
    actor: str = "admin",
) -> Dict[str, Any]:
    """Restaura o fusiona activistas y estructura con auto-backup previo y rollback seguro."""
    ahora = datetime.now(timezone.utc).isoformat()
    with CACHE_LOCK:
        _crear_respaldo_automatico_locked("pre_restore")
        prev_act = dict(ACTIVISTAS_CACHE)
        prev_est = dict(ESTRUCTURA_CACHE)
        try:
            old_act_ids = list(ACTIVISTAS_CACHE.keys())
            old_est_ids = list(ESTRUCTURA_CACHE.keys())

            if modo == "reemplazar":
                ACTIVISTAS_CACHE.clear()
                ESTRUCTURA_CACHE.clear()

            touched_acts: Dict[str, Dict[str, Any]] = {}
            touched_ests: Dict[str, Dict[str, Any]] = {}

            for est in estructura_list:
                res = _asegurar_estructura_item_locked(
                    rol=str(est.get("rol") or ""),
                    nombre=str(est.get("nombre") or ""),
                    ahora=ahora,
                    cedula=str(est.get("cedula") or ""),
                    telefono=str(est.get("telefono") or ""),
                    codigo_municipio=str(est.get("codigo_municipio") or ""),
                    municipio=str(est.get("municipio") or ""),
                    codigo_representante=str(est.get("codigo_representante") or ""),
                    sobrescribir_meta=True,
                )
                if res:
                    item, _ = res
                    touched_ests[item["id"]] = item

            for act in activistas_list:
                preparado = _preparar_activista_locked(act, ahora, actor=actor)
                ced = preparado["cedula"]
                ACTIVISTAS_CACHE[ced] = dict(preparado)
                touched_acts[ced] = dict(preparado)
                for est_item in _extraer_estructura_de_activista_locked(preparado, ahora):
                    touched_ests[est_item["id"]] = est_item

            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                col_act = _FIRESTORE_DB.collection("activistas")
                col_est = _FIRESTORE_DB.collection("estructura")
                if modo == "reemplazar":
                    for old_ced in old_act_ids:
                        if old_ced not in ACTIVISTAS_CACHE:
                            ops.append(("delete", col_act.document(old_ced), None))
                    for old_eid in old_est_ids:
                        if old_eid not in ESTRUCTURA_CACHE:
                            ops.append(("delete", col_est.document(old_eid), None))
                for ced, act_item in touched_acts.items():
                    ops.append(("set", col_act.document(ced), act_item))
                for eid, est_item in touched_ests.items():
                    ops.append(("set", col_est.document(eid), est_item))

            _persistir_cambios_locked(ops, save_act=True, save_est=True)
            return {
                "total_activistas": len(ACTIVISTAS_CACHE),
                "total_estructura": len(ESTRUCTURA_CACHE),
                "activistas_procesados": len(touched_acts),
                "estructura_procesada": len(touched_ests),
            }
        except Exception:
            ACTIVISTAS_CACHE.clear()
            ACTIVISTAS_CACHE.update(prev_act)
            ESTRUCTURA_CACHE.clear()
            ESTRUCTURA_CACHE.update(prev_est)
            raise


# ==============================================================================
# GESTIÓN DE USUARIOS (CACHÉ EN MEMORIA + PERSISTENCIA CON ROLLBACK)
# ==============================================================================
def _usuario_publico(u: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "username": u["username"],
        "nombre": u.get("nombre", u["username"]),
        "rol": u.get("rol", "consulta"),
        "activo": bool(u.get("activo", True)),
        "from_env": bool(u.get("from_env", False)),
        "fecha_registro": u.get("fecha_registro", ""),
        "fecha_actualizacion": u.get("fecha_actualizacion", ""),
    }


def obtener_usuario_cache(username: str) -> Optional[Dict[str, Any]]:
    uname = str(username or "").strip().lower()
    with CACHE_LOCK:
        item = USUARIOS_CACHE.get(uname)
        return dict(item) if item else None


def listar_usuarios_cache() -> List[Dict[str, Any]]:
    with CACHE_LOCK:
        items = [_usuario_publico(u) for u in USUARIOS_CACHE.values()]
    items.sort(key=lambda x: (x["rol"] != "admin", x["username"]))
    return items


def guardar_usuario_db(user_record: Dict[str, Any]) -> Dict[str, Any]:
    uname = str(user_record.get("username") or "").strip().lower()
    if not uname:
        raise ValueError("Username inválido.")
    ahora = datetime.now(timezone.utc).isoformat()

    with CACHE_LOCK:
        prev_usr = dict(USUARIOS_CACHE)
        try:
            existente = USUARIOS_CACHE.get(uname)
            record = dict(user_record)
            record["username"] = uname
            record["fecha_registro"] = (
                existente.get("fecha_registro", ahora) if existente else ahora
            )
            record["fecha_actualizacion"] = ahora
            USUARIOS_CACHE[uname] = record

            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                ops.append(("set", _FIRESTORE_DB.collection("usuarios").document(uname), record))
            _persistir_cambios_locked(ops, save_act=False, save_est=False, save_usr=True)
            return _usuario_publico(record)
        except Exception:
            USUARIOS_CACHE.clear()
            USUARIOS_CACHE.update(prev_usr)
            raise


def eliminar_usuario_db(username: str) -> bool:
    uname = str(username or "").strip().lower()
    with CACHE_LOCK:
        if uname not in USUARIOS_CACHE:
            return False
        prev_usr = dict(USUARIOS_CACHE)
        try:
            USUARIOS_CACHE.pop(uname, None)
            ops: List[Tuple[str, Any, Optional[Dict[str, Any]]]] = []
            if _MODO_PERSISTENCIA == "firestore" and _FIRESTORE_DB is not None:
                ops.append(("delete", _FIRESTORE_DB.collection("usuarios").document(uname), None))
            _persistir_cambios_locked(ops, save_act=False, save_est=False, save_usr=True)
            return True
        except Exception:
            USUARIOS_CACHE.clear()
            USUARIOS_CACHE.update(prev_usr)
            raise

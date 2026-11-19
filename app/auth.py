import hashlib
import json
import logging
import os
import secrets
import threading
import time
import urllib.parse
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional

from fastapi import Depends, Header, HTTPException, Request, status

from app import config, database

logger = logging.getLogger("ap_aragua.auth")

COOKIE_NAME = "ap_session"
_MAX_ACTIVE_SESSIONS = 50
_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32

# Almacenamiento en memoria indexado ÚNICAMENTE por sha256(token)
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}
TOKENS_LOCK = threading.Lock()

# Rate limiting y bloqueo progresivo de login
_LOGIN_RATE_BUCKETS: Dict[str, List[float]] = defaultdict(list)
_AUTH_RATE_BUCKETS: Dict[str, List[float]] = defaultdict(list)
_LOGIN_FAILURES: Dict[str, Dict[str, Any]] = {}
_RATE_LOCK = threading.Lock()
_LOCKOUT_THRESHOLD = 5
_LOCKOUT_SECONDS = 60.0

_DUMMY_HASH = (
    "scrypt$00112233445566778899aabbccddeeff$"
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
)


def hash_password(plain: str) -> str:
    """Genera un hash seguro usando scrypt con salt aleatorio de 16 bytes."""
    salt = os.urandom(16)
    digest = hashlib.scrypt(
        plain.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(plain: str, stored: str) -> bool:
    """Verifica contraseña contra hash scrypt en tiempo constante."""
    try:
        parts = str(stored or "").split("$")
        if len(parts) != 3 or parts[0] != "scrypt":
            return False
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
        computed = hashlib.scrypt(
            plain.encode("utf-8"),
            salt=salt,
            n=_SCRYPT_N,
            r=_SCRYPT_R,
            p=_SCRYPT_P,
            dklen=len(expected),
        )
        return secrets.compare_digest(computed, expected)
    except Exception:
        return False


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def ensure_default_admin() -> None:
    """Garantiza que exista al menos un usuario admin; sincroniza ADMIN_PASSWORD si proviene de .env."""
    admin_uname = config.ADMIN_USERNAME
    usuarios = database.listar_usuarios_cache()
    tiene_admin = any(u.get("rol") == "admin" and u.get("activo", True) for u in usuarios)
    existente = database.obtener_usuario_cache(admin_uname)

    if not tiene_admin:
        database.guardar_usuario_db(
            {
                "username": admin_uname,
                "nombre": "Administrador Principal",
                "rol": "admin",
                "activo": True,
                "from_env": True,
                "password_hash": hash_password(config.ADMIN_PASSWORD),
            }
        )
        logger.info("Usuario administrador por defecto '%s' inicializado.", admin_uname)
        return

    if existente and existente.get("from_env", False):
        if not verify_password(config.ADMIN_PASSWORD, existente.get("password_hash", "")):
            actualizado = dict(existente)
            actualizado["password_hash"] = hash_password(config.ADMIN_PASSWORD)
            actualizado["activo"] = True
            database.guardar_usuario_db(actualizado)
            logger.info("Clave de '%s' sincronizada desde configuración de entorno.", admin_uname)


def es_multi_usuario() -> bool:
    """Retorna True cuando hay más de un usuario configurado en el sistema."""
    return len(database.listar_usuarios_cache()) > 1


def _guardar_sesiones_locked() -> None:
    """Persiste las sesiones vigentes (solo hashes) en disco de forma atómica (requiere TOKENS_LOCK)."""
    now = time.time()
    vigentes = {
        tok_hash: meta
        for tok_hash, meta in ACTIVE_SESSIONS.items()
        if isinstance(meta, dict)
        and meta.get("exp", 0) > now
        and (now - meta.get("last_seen", now)) <= config.SESSION_IDLE_SECONDS
    }
    if len(vigentes) > _MAX_ACTIVE_SESSIONS:
        ordenadas = sorted(
            vigentes.items(), key=lambda kv: kv[1].get("last_seen", 0), reverse=True
        )[:_MAX_ACTIVE_SESSIONS]
        vigentes = dict(ordenadas)

    ACTIVE_SESSIONS.clear()
    ACTIVE_SESSIONS.update(vigentes)
    try:
        config.SESSIONS_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = config.SESSIONS_FILE_PATH.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(vigentes, f)
        os.replace(tmp_path, config.SESSIONS_FILE_PATH)
    except Exception as exc:
        logger.warning("No se pudo persistir sesiones locales: %s", exc)


def cargar_sesiones() -> None:
    """Carga sesiones activas no expiradas desde disco al iniciar."""
    if not config.SESSIONS_FILE_PATH.exists():
        return
    now = time.time()
    try:
        with open(config.SESSIONS_FILE_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return
        with TOKENS_LOCK:
            ACTIVE_SESSIONS.clear()
            for tok_hash, meta in raw.items():
                if (
                    isinstance(tok_hash, str)
                    and len(tok_hash) == 64
                    and isinstance(meta, dict)
                    and float(meta.get("exp", 0)) > now
                    and (now - float(meta.get("last_seen", now))) <= config.SESSION_IDLE_SECONDS
                ):
                    ACTIVE_SESSIONS[tok_hash] = meta
    except Exception as exc:
        logger.warning("No se pudo cargar sesiones locales: %s", exc)


def crear_sesion(usuario: Dict[str, Any]) -> str:
    """Crea una nueva sesión y retorna el token en claro (solo el hash se almacena)."""
    token = secrets.token_urlsafe(32)
    tok_hash = _hash_token(token)
    now = time.time()
    meta = {
        "username": usuario["username"],
        "nombre": usuario.get("nombre", usuario["username"]),
        "rol": usuario.get("rol", "consulta"),
        "exp": now + config.SESSION_TTL_SECONDS,
        "last_seen": now,
    }
    with TOKENS_LOCK:
        ACTIVE_SESSIONS[tok_hash] = meta
        _guardar_sesiones_locked()
    return token


def revocar_sesion(token: str) -> None:
    if not token:
        return
    tok_hash = _hash_token(token)
    with TOKENS_LOCK:
        ACTIVE_SESSIONS.pop(tok_hash, None)
        _guardar_sesiones_locked()


def revocar_sesiones_usuario(username: str) -> None:
    uname = str(username or "").strip().lower()
    with TOKENS_LOCK:
        victimas = [
            h for h, m in ACTIVE_SESSIONS.items() if m.get("username") == uname
        ]
        if victimas:
            for h in victimas:
                ACTIVE_SESSIONS.pop(h, None)
            _guardar_sesiones_locked()


def get_client_ip(request: Request) -> str:
    direct_ip = request.client.host if request.client else "127.0.0.1"
    if direct_ip in config.TRUSTED_PROXIES:
        xff = request.headers.get("X-Forwarded-For", "").strip()
        if xff:
            return xff.split(",")[0].strip()
    return direct_ip


def _aplicar_rate_limit(
    request: Request,
    buckets: Dict[str, List[float]],
    max_requests: int,
    detail: str,
) -> None:
    client_ip = get_client_ip(request)
    now = time.monotonic()
    with _RATE_LOCK:
        if len(buckets) > 512:
            stale = [
                ip
                for ip, timestamps in buckets.items()
                if not timestamps or (now - timestamps[-1]) >= config.RATE_LIMIT_WINDOW
            ]
            for ip in stale:
                buckets.pop(ip, None)

        ventana = [t for t in buckets[client_ip] if now - t < config.RATE_LIMIT_WINDOW]
        if len(ventana) >= max_requests:
            buckets[client_ip] = ventana
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=detail,
            )
        ventana.append(now)
        buckets[client_ip] = ventana


def login_rate_limit_dep(request: Request) -> None:
    """Limita intentos de login y aplica bloqueo temporal tras fallos consecutivos."""
    client_ip = get_client_ip(request)
    now = time.monotonic()
    with _RATE_LOCK:
        fail_info = _LOGIN_FAILURES.get(client_ip)
        if fail_info and fail_info.get("locked_until", 0.0) > now:
            restante = int(fail_info["locked_until"] - now) + 1
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Demasiados intentos fallidos. Intente en {restante} segundos.",
            )

    _aplicar_rate_limit(
        request,
        _LOGIN_RATE_BUCKETS,
        config.LOGIN_RATE_LIMIT_MAX,
        f"Límite de {config.LOGIN_RATE_LIMIT_MAX} intentos por minuto alcanzado. Intente en unos segundos.",
    )


def registrar_fallo_login(request: Request) -> None:
    client_ip = get_client_ip(request)
    now = time.monotonic()
    with _RATE_LOCK:
        if len(_LOGIN_FAILURES) > 512:
            expirados = [
                ip
                for ip, info in _LOGIN_FAILURES.items()
                if (now - info.get("last_fail", 0.0)) > 300.0
            ]
            for ip in expirados:
                _LOGIN_FAILURES.pop(ip, None)
        info = _LOGIN_FAILURES.get(client_ip, {"count": 0, "locked_until": 0.0, "last_fail": now})
        if (now - info["last_fail"]) > 300.0:
            info["count"] = 0
        info["count"] += 1
        info["last_fail"] = now
        if info["count"] >= _LOCKOUT_THRESHOLD:
            info["locked_until"] = now + _LOCKOUT_SECONDS
            info["count"] = 0
        _LOGIN_FAILURES[client_ip] = info


def limpiar_fallos_login(request: Request) -> None:
    client_ip = get_client_ip(request)
    with _RATE_LOCK:
        _LOGIN_FAILURES.pop(client_ip, None)


def auth_rate_limit_dep(request: Request) -> None:
    """Rate limiter operativo para sesiones autenticadas."""
    _aplicar_rate_limit(
        request,
        _AUTH_RATE_BUCKETS,
        config.AUTH_RATE_LIMIT_MAX,
        f"Límite de {config.AUTH_RATE_LIMIT_MAX} consultas por minuto alcanzado. Intente en unos segundos.",
    )


def autenticar_credenciales(username: str, password: str) -> Optional[Dict[str, Any]]:
    """Valida credenciales de usuario usando tiempo constante."""
    uname = (username or "").strip().lower() or config.ADMIN_USERNAME
    usuario = database.obtener_usuario_cache(uname)
    if not usuario or not usuario.get("activo", True):
        verify_password(password, _DUMMY_HASH)
        return None
    if not verify_password(password, usuario.get("password_hash", "")):
        return None
    return usuario


def _verificar_csrf_cookie(request: Request) -> None:
    if request.method.upper() not in ("POST", "PUT", "PATCH", "DELETE"):
        return
    if request.headers.get("X-Requested-With", "").strip() == "XMLHttpRequest":
        return
    origin = request.headers.get("Origin", "").strip()
    host = request.headers.get("Host", "").strip()
    if origin and host:
        parsed = urllib.parse.urlparse(origin)
        if parsed.netloc == host:
            return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Solicitud rechazada por validación CSRF.",
    )


def get_current_user(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    _: None = Depends(auth_rate_limit_dep),
) -> Dict[str, Any]:
    """Valida Bearer o cookie HttpOnly mediante hash en tiempo constante y TTL/inactividad."""
    provided = ""
    via_cookie = False

    if authorization and authorization.startswith("Bearer "):
        provided = authorization[7:].strip()
    elif COOKIE_NAME in request.cookies:
        provided = (request.cookies.get(COOKIE_NAME) or "").strip()
        via_cookie = True

    if not provided:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesión no iniciada o token ausente.",
        )

    if via_cookie:
        _verificar_csrf_cookie(request)

    provided_hash = _hash_token(provided)
    now = time.time()
    matched_hash: Optional[str] = None
    matched_meta: Optional[Dict[str, Any]] = None

    with TOKENS_LOCK:
        expirados = [
            h
            for h, m in ACTIVE_SESSIONS.items()
            if m.get("exp", 0) <= now
            or (now - m.get("last_seen", now)) > config.SESSION_IDLE_SECONDS
        ]
        for h in expirados:
            ACTIVE_SESSIONS.pop(h, None)

        for tok_hash, meta in ACTIVE_SESSIONS.items():
            if secrets.compare_digest(provided_hash, tok_hash):
                matched_hash = tok_hash
                matched_meta = meta

        if matched_hash and matched_meta:
            prev_seen = float(matched_meta.get("last_seen", 0))
            matched_meta["last_seen"] = now
            if expirados or (now - prev_seen) > 60.0:
                _guardar_sesiones_locked()
        elif expirados:
            _guardar_sesiones_locked()

    if not matched_meta or not matched_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesión expirada o inválida. Vuelva a iniciar sesión.",
        )

    usuario = database.obtener_usuario_cache(matched_meta["username"])
    if not usuario or not usuario.get("activo", True):
        with TOKENS_LOCK:
            ACTIVE_SESSIONS.pop(matched_hash, None)
            _guardar_sesiones_locked()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuario deshabilitado o inexistente.",
        )

    return {
        "username": usuario["username"],
        "nombre": usuario.get("nombre", usuario["username"]),
        "rol": usuario.get("rol", "consulta"),
        "token": provided,
        "via_cookie": via_cookie,
    }


def require_roles(*roles: str) -> Callable[..., Dict[str, Any]]:
    """Genera una dependencia FastAPI que exige que el usuario posea uno de los roles indicados."""
    allowed = set(roles)

    def _checker(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if user.get("rol") not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No tiene permisos para realizar esta acción.",
            )
        return user

    return _checker

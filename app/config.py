import logging
import os
from pathlib import Path
from typing import Set

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Cargar .env antes de leer cualquier variable de entorno
load_dotenv(BASE_DIR / ".env")


def _resolve_path(env_name: str, default_rel: str) -> Path:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return BASE_DIR / default_rel
    p = Path(raw)
    return p if p.is_absolute() else (BASE_DIR / p)


def _int_env(env_name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


APP_ENV = os.getenv("APP_ENV", "development").strip().lower() or "development"
IS_PRODUCTION = APP_ENV == "production"

STATIC_DIR = Path(__file__).resolve().parent / "static"
PADRON_DB_PATH = _resolve_path("PADRON_DB_PATH", "padron_cne.db")
FIREBASE_CRED_PATH = _resolve_path("FIREBASE_CREDENTIALS_PATH", "serviceAccountKey.json")
LOCAL_FALLBACK_PATH = _resolve_path("LOCAL_FALLBACK_PATH", "activistas_local.json")
LOCAL_ESTRUCTURA_PATH = _resolve_path("LOCAL_ESTRUCTURA_PATH", "estructura_local.json")
LOCAL_USUARIOS_PATH = _resolve_path("LOCAL_USUARIOS_PATH", "usuarios_local.json")
BACKUPS_DIR = _resolve_path("BACKUPS_DIR", "backups")
MAX_AUTO_BACKUPS = _int_env("MAX_AUTO_BACKUPS", 15, minimum=1)

SESSIONS_FILE_PATH = _resolve_path("SESSIONS_FILE_PATH", ".sessions_local.json")
SESSION_TTL_SECONDS = _int_env("SESSION_TTL_SECONDS", 86400, minimum=60)
SESSION_IDLE_SECONDS = _int_env("SESSION_IDLE_SECONDS", 3600, minimum=60)

ADMIN_USERNAME = (os.getenv("ADMIN_USERNAME", "admin") or "admin").strip().lower()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "ap2026")

_login_limit_raw = os.getenv("LOGIN_RATE_LIMIT_MAX") or os.getenv("RATE_LIMIT_MAX") or "10"
try:
    LOGIN_RATE_LIMIT_MAX = max(1, int(_login_limit_raw))
except ValueError:
    LOGIN_RATE_LIMIT_MAX = 10

AUTH_RATE_LIMIT_MAX = _int_env("AUTH_RATE_LIMIT_MAX", 180, minimum=10)
RATE_LIMIT_WINDOW = 60.0

TRUSTED_PROXIES: Set[str] = {
    ip.strip()
    for ip in os.getenv("TRUSTED_PROXIES", "").split(",")
    if ip.strip()
}


def configure_logging() -> logging.Logger:
    """Configura el sistema de logging estructurado de la aplicación."""
    root_logger = logging.getLogger()
    if not root_logger.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        )
    app_logger = logging.getLogger("ap_aragua")
    if IS_PRODUCTION and ADMIN_PASSWORD == "ap2026":
        app_logger.warning(
            "SEGURIDAD CRÍTICA: APP_ENV=production con ADMIN_PASSWORD por defecto ('ap2026'). "
            "Configure una clave segura en .env o cámbiela desde la aplicación."
        )
    return app_logger

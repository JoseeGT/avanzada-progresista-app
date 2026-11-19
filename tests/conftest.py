import pytest
from fastapi.testclient import TestClient

from app import auth, config, database, padron
from app.main import app


@pytest.fixture()
def isolated_env(tmp_path, monkeypatch):
    """Aísla completamente archivos, sesiones, respaldos y SQLite en tmp_path."""
    monkeypatch.setattr(config, "PADRON_DB_PATH", tmp_path / "padron_test.db")
    monkeypatch.setattr(config, "FIREBASE_CRED_PATH", tmp_path / "no_firebase.json")
    monkeypatch.setattr(config, "LOCAL_FALLBACK_PATH", tmp_path / "activistas_test.json")
    monkeypatch.setattr(config, "LOCAL_ESTRUCTURA_PATH", tmp_path / "estructura_test.json")
    monkeypatch.setattr(config, "LOCAL_USUARIOS_PATH", tmp_path / "usuarios_test.json")
    monkeypatch.setattr(config, "BACKUPS_DIR", tmp_path / "backups")
    monkeypatch.setattr(config, "SESSIONS_FILE_PATH", tmp_path / ".sessions_test.json")
    monkeypatch.setattr(config, "ADMIN_USERNAME", "admin")
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "AdminClaveSegura2026!")
    monkeypatch.setattr(config, "LOGIN_RATE_LIMIT_MAX", 10)
    monkeypatch.setattr(config, "AUTH_RATE_LIMIT_MAX", 200)
    monkeypatch.setattr(config, "SESSION_IDLE_SECONDS", 3600)

    with database.CACHE_LOCK:
        database.ACTIVISTAS_CACHE.clear()
        database.ESTRUCTURA_CACHE.clear()
        database.USUARIOS_CACHE.clear()
    with padron._PADRON_LOCK:
        padron._SQLITE_TABLE_CACHE.clear()
        padron.CENTROS_CNE_CACHE.clear()
        padron.CNE_MUN_ID_MAP.clear()
        padron.CNE_PAR_ID_MAP.clear()
        padron.ELECTORES_POR_MUNICIPIO.clear()
        padron.ELECTORES_POR_PARROQUIA.clear()
        padron.TOTAL_ELECTORES_PADRON = 0
    with auth.TOKENS_LOCK:
        auth.ACTIVE_SESSIONS.clear()
    with auth._RATE_LOCK:
        auth._LOGIN_RATE_BUCKETS.clear()
        auth._AUTH_RATE_BUCKETS.clear()
        auth._LOGIN_FAILURES.clear()

    return tmp_path


@pytest.fixture()
def client(isolated_env):
    with TestClient(app) as tc:
        yield tc

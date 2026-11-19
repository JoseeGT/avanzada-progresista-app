import gzip
import sqlite3
from pathlib import Path

from app import config, padron
from app.padron_unpack import descomprimir_padron_si_falta


def _crear_sqlite_muestra(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            """
            CREATE TABLE electores (
                cedula TEXT PRIMARY KEY,
                nombre_apellido TEXT NOT NULL,
                sexo TEXT NOT NULL,
                municipio TEXT NOT NULL,
                parroquia TEXT NOT NULL,
                centro_votacion TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO electores (cedula, nombre_apellido, sexo, municipio, parroquia, centro_votacion)
            VALUES ('99887766', 'ELECTOR PRUEBA UNPACK', 'H', 'GIRARDOT', 'LAS DELICIAS', 'U.E.N. PRUEBA')
            """
        )
        conn.commit()
    finally:
        conn.close()


def test_descomprimir_gz_unico_y_pragmas_ro(isolated_env, monkeypatch):
    src_db = isolated_env / "origen.db"
    _crear_sqlite_muestra(src_db)

    target_db = isolated_env / "padron_unpack.db"
    gz_path = isolated_env / "padron_unpack.db.gz"
    with open(src_db, "rb") as f_in, gzip.open(gz_path, "wb", compresslevel=6) as f_out:
        f_out.write(f_in.read())

    monkeypatch.setattr(config, "PADRON_DB_PATH", target_db)
    assert not target_db.exists()

    padron.cargar_catalogo_padron()
    assert target_db.exists()
    assert padron.TOTAL_ELECTORES_PADRON == 1

    conn = padron._conectar_ro(target_db)
    try:
        assert conn.execute("PRAGMA query_only;").fetchone()[0] == 1
        assert conn.execute("PRAGMA cache_size;").fetchone()[0] == -8000
    finally:
        conn.close()


def test_descomprimir_desde_fragmentos_part(tmp_path):
    src_db = tmp_path / "origen.db"
    _crear_sqlite_muestra(src_db)

    raw_gz = gzip.compress(src_db.read_bytes(), compresslevel=6)
    mid = len(raw_gz) // 2
    target_db = tmp_path / "padron_parts.db"
    Path(f"{target_db}.gz.part001").write_bytes(raw_gz[:mid])
    Path(f"{target_db}.gz.part002").write_bytes(raw_gz[mid:])

    assert descomprimir_padron_si_falta(target_db) is True
    assert target_db.exists()
    conn = sqlite3.connect(f"file:{target_db.as_posix()}?mode=ro", uri=True)
    try:
        row = conn.execute("SELECT cedula FROM electores").fetchone()
        assert row is not None and row[0] == "99887766"
    finally:
        conn.close()

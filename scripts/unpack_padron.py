"""Script de build para descomprimir el padrón CNE antes de iniciar el servidor."""

import logging
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.padron_unpack import descomprimir_padron_si_falta  # noqa: E402


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    raw_path = os.getenv("PADRON_DB_PATH", "padron_cne.db").strip() or "padron_cne.db"
    db_path = Path(raw_path)
    if not db_path.is_absolute():
        db_path = BASE_DIR / db_path

    if db_path.exists() and db_path.stat().st_size > 0:
        logging.info("El padrón ya existe en %s; omitiendo descompresión.", db_path)
        return 0

    ok = descomprimir_padron_si_falta(db_path)
    if not ok:
        logging.warning(
            "No se encontró %s.gz ni fragmentos .part* para descomprimir.",
            db_path,
        )
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

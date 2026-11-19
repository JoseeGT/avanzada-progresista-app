"""Genera app/data/catalogo_cne.json precalculado desde padron_cne.db para arranque instantáneo."""

import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app import config, padron  # noqa: E402


def main() -> int:
    padron.cargar_catalogo_padron()
    out_path = BASE_DIR / "app" / "data" / "catalogo_cne.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "total_electores_padron": padron.TOTAL_ELECTORES_PADRON,
        "centros": padron.CENTROS_CNE_CACHE,
        "mun_id_map": padron.CNE_MUN_ID_MAP,
        "par_id_map": {f"{k[0]}|{k[1]}": list(v) for k, v in padron.CNE_PAR_ID_MAP.items()},
        "electores_por_municipio": padron.ELECTORES_POR_MUNICIPIO,
        "electores_por_parroquia": {
            f"{k[0]}|{k[1]}": v for k, v in padron.ELECTORES_POR_PARROQUIA.items()
        },
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(
        f"Generado {out_path} ({out_path.stat().st_size / 1024:.1f} KB): "
        f"{len(padron.CENTROS_CNE_CACHE)} centros, {padron.TOTAL_ELECTORES_PADRON} electores."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

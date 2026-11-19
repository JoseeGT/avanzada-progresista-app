"""Descompresión por streaming del padrón SQLite (.db.gz o partes .db.gz.part*)."""

import gzip
import io
import logging
import os
import shutil
from pathlib import Path
from typing import List

logger = logging.getLogger("ap_aragua.padron_unpack")

_CHUNK_BYTES = 1024 * 1024  # 1 MB para consumo mínimo de RAM


class _MultiPartBinaryReader(io.RawIOBase):
    """Lee secuencialmente una lista de archivos binarios sin cargarlos en RAM."""

    def __init__(self, parts: List[Path]) -> None:
        self._parts = list(parts)
        self._idx = 0
        self._current = None

    def readable(self) -> bool:
        return True

    def readinto(self, b: bytearray | memoryview) -> int:
        while True:
            if self._current is None:
                if self._idx >= len(self._parts):
                    return 0
                self._current = open(self._parts[self._idx], "rb")
            n = self._current.readinto(b)
            if n:
                return n
            self._current.close()
            self._current = None
            self._idx += 1

    def close(self) -> None:
        if self._current is not None:
            self._current.close()
            self._current = None
        super().close()


def _encontrar_partes(gz_path: Path) -> List[Path]:
    return sorted(gz_path.parent.glob(f"{gz_path.name}.part*"))


def descomprimir_padron_si_falta(db_path: Path) -> bool:
    """
    Si `db_path` no existe, intenta descomprimir `<db_path>.gz` o sus fragmentos
    `<db_path>.gz.part*` mediante streaming de bajo consumo de memoria.

    Retorna True si el archivo `.db` quedó disponible, False si no había fuente comprimida.
    """
    if db_path.exists() and db_path.stat().st_size > 0:
        return True

    gz_path = Path(f"{db_path}.gz")
    partes = _encontrar_partes(gz_path)

    if not gz_path.exists() and not partes:
        return False

    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = db_path.with_suffix(f"{db_path.suffix}.tmp")

    try:
        if gz_path.exists():
            logger.info("Descomprimiendo padrón desde %s...", gz_path.name)
            with open(gz_path, "rb") as raw_in, gzip.GzipFile(
                fileobj=raw_in, mode="rb"
            ) as gz_in, open(tmp_path, "wb") as out_f:
                shutil.copyfileobj(gz_in, out_f, length=_CHUNK_BYTES)
        else:
            logger.info(
                "Descomprimiendo padrón desde %d fragmentos (%s.part*)...",
                len(partes),
                gz_path.name,
            )
            with _MultiPartBinaryReader(partes) as raw_in, io.BufferedReader(
                raw_in, buffer_size=_CHUNK_BYTES
            ) as buf_in, gzip.GzipFile(
                fileobj=buf_in, mode="rb"
            ) as gz_in, open(tmp_path, "wb") as out_f:
                shutil.copyfileobj(gz_in, out_f, length=_CHUNK_BYTES)

        os.replace(tmp_path, db_path)
        logger.info(
            "Padrón descomprimido correctamente en %s (%.2f MB).",
            db_path,
            db_path.stat().st_size / (1024 * 1024),
        )
        return True
    except Exception:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise

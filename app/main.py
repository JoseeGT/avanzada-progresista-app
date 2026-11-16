import csv
import io
import os
import secrets
import threading
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.database import (
    buscar_elector_sqlite,
    calcular_estadisticas,
    eliminar_activista_db,
    filtrar_activistas,
    generar_codigo_planilla,
    guardar_activista_db,
    guardar_activistas_lote_db,
    init_databases,
    obtener_activista_cache,
    obtener_estado_sistema,
)
from app.models import (
    CATALOGO_GEOGRAFICO,
    ActivistaInput,
    LoginRequest,
    LoteActivistasInput,
    limpiar_cedula,
)

load_dotenv()

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "ap2026")
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Sesiones activas en memoria (single-admin)
ACTIVE_TOKENS: set = set()
TOKENS_LOCK = threading.Lock()

# Rate Limiter nativo en memoria: máx 30 consultas por minuto por IP
RATE_LIMIT_MAX = 30
RATE_LIMIT_WINDOW = 60.0
_RATE_BUCKETS: Dict[str, List[float]] = defaultdict(list)
_RATE_LOCK = threading.Lock()


def rate_limit_dep(request: Request) -> None:
    """Limita a máximo 30 consultas por minuto por dirección IP."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    now = time.monotonic()
    with _RATE_LOCK:
        ventana = [t for t in _RATE_BUCKETS[client_ip] if now - t < RATE_LIMIT_WINDOW]
        if len(ventana) >= RATE_LIMIT_MAX:
            _RATE_BUCKETS[client_ip] = ventana
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Límite de 30 consultas por minuto alcanzado. Intente en unos segundos.",
            )
        ventana.append(now)
        _RATE_BUCKETS[client_ip] = ventana


def verify_token(
    authorization: Optional[str] = Header(default=None),
    _: None = Depends(rate_limit_dep),
) -> str:
    """Verifica el token Bearer usando comparación en tiempo constante (secrets.compare_digest)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesión no iniciada o token ausente.",
        )
    provided = authorization[7:].strip()
    if not provided:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido.",
        )
    with TOKENS_LOCK:
        valido = any(secrets.compare_digest(provided, tok) for tok in ACTIVE_TOKENS)
    if not valido:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesión expirada o inválida. Vuelva a iniciar sesión.",
        )
    return provided


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_databases()
    yield


app = FastAPI(
    title="Sistema de Gestión Electoral - Avanzada Progresista Aragua",
    version="1.0.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def serve_index() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.post("/api/login")
def login(payload: LoginRequest, _: None = Depends(rate_limit_dep)) -> Dict[str, Any]:
    if not secrets.compare_digest(payload.password, ADMIN_PASSWORD):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Clave de acceso incorrecta.",
        )
    token = secrets.token_urlsafe(32)
    with TOKENS_LOCK:
        ACTIVE_TOKENS.add(token)
    return {"ok": True, "token": token}


@app.post("/api/logout")
def logout(token: str = Depends(verify_token)) -> Dict[str, Any]:
    with TOKENS_LOCK:
        ACTIVE_TOKENS.discard(token)
    return {"ok": True}


@app.get("/api/estado-sistema")
def estado_sistema(_: str = Depends(verify_token)) -> Dict[str, Any]:
    return obtener_estado_sistema()


@app.get("/api/catalogo-geografico")
def catalogo_geografico(_: str = Depends(verify_token)) -> List[Dict[str, Any]]:
    return CATALOGO_GEOGRAFICO


@app.get("/api/elector/{cedula}")
def consultar_elector(cedula: str, _: str = Depends(verify_token)) -> Dict[str, Any]:
    ced_limpia = limpiar_cedula(cedula)
    if len(ced_limpia) < 5:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ingrese un número de cédula válido (mínimo 5 dígitos).",
        )

    # 1. Buscar primero en caché de activistas registrados
    activista = obtener_activista_cache(ced_limpia)
    if activista:
        return {
            "encontrado_en": "activistas",
            "modo_edicion": True,
            "datos": activista,
        }

    # 2. Buscar en padron_aragua.db (SQLite solo lectura)
    elector = buscar_elector_sqlite(ced_limpia)
    if elector:
        cod_mun = elector.get("codigo_municipio") or "01"
        elector["codigo"] = generar_codigo_planilla(cod_mun)
        return {
            "encontrado_en": "padron",
            "modo_edicion": False,
            "datos": elector,
        }

    # 3. No encontrado: permitir registro manual
    return {
        "encontrado_en": "ninguno",
        "modo_edicion": False,
        "datos": {
            "cedula": ced_limpia,
            "codigo": generar_codigo_planilla("01"),
        },
    }


@app.get("/api/activistas/codigo-siguiente/{codigo_municipio}")
def codigo_siguiente(codigo_municipio: str, _: str = Depends(verify_token)) -> Dict[str, str]:
    return {"codigo": generar_codigo_planilla(codigo_municipio)}


@app.get("/api/activistas")
def listar_activistas(
    cedula: Optional[str] = Query(default=None),
    codigo: Optional[str] = Query(default=None),
    codigo_municipio: Optional[str] = Query(default=None),
    codigo_parroquia: Optional[str] = Query(default=None),
    centro_votacion: Optional[str] = Query(default=None),
    enlace: Optional[str] = Query(default=None),
    responsable_cal: Optional[str] = Query(default=None),
    responsable_local: Optional[str] = Query(default=None),
    responsable_comunidad: Optional[str] = Query(default=None),
    comunidad: Optional[str] = Query(default=None),
    _: str = Depends(verify_token),
) -> Dict[str, Any]:
    registros = filtrar_activistas(
        cedula=cedula,
        codigo=codigo,
        codigo_municipio=codigo_municipio,
        codigo_parroquia=codigo_parroquia,
        centro_votacion=centro_votacion,
        enlace=enlace,
        responsable_cal=responsable_cal,
        responsable_local=responsable_local,
        responsable_comunidad=responsable_comunidad,
        comunidad=comunidad,
    )
    return {"total": len(registros), "registros": registros}


@app.post("/api/activistas")
def guardar_activista(
    payload: ActivistaInput, _: str = Depends(verify_token)
) -> Dict[str, Any]:
    guardado = guardar_activista_db(payload.model_dump())
    return {"ok": True, "activista": guardado}


@app.post("/api/activistas/lote")
def guardar_activistas_lote(
    payload: LoteActivistasInput, _: str = Depends(verify_token)
) -> Dict[str, Any]:
    resultado = guardar_activistas_lote_db([a.model_dump() for a in payload.activistas])
    return {"ok": True, **resultado}


@app.delete("/api/activistas/{cedula}")
def eliminar_activista(cedula: str, _: str = Depends(verify_token)) -> Dict[str, Any]:
    eliminado = eliminar_activista_db(cedula)
    if not eliminado:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Activista no encontrado.",
        )
    return {"ok": True}


@app.get("/api/activistas/exportar-csv")
def exportar_csv(
    cedula: Optional[str] = Query(default=None),
    codigo: Optional[str] = Query(default=None),
    codigo_municipio: Optional[str] = Query(default=None),
    codigo_parroquia: Optional[str] = Query(default=None),
    centro_votacion: Optional[str] = Query(default=None),
    enlace: Optional[str] = Query(default=None),
    responsable_cal: Optional[str] = Query(default=None),
    responsable_local: Optional[str] = Query(default=None),
    responsable_comunidad: Optional[str] = Query(default=None),
    comunidad: Optional[str] = Query(default=None),
    _: str = Depends(verify_token),
) -> StreamingResponse:
    registros = filtrar_activistas(
        cedula=cedula,
        codigo=codigo,
        codigo_municipio=codigo_municipio,
        codigo_parroquia=codigo_parroquia,
        centro_votacion=centro_votacion,
        enlace=enlace,
        responsable_cal=responsable_cal,
        responsable_local=responsable_local,
        responsable_comunidad=responsable_comunidad,
        comunidad=comunidad,
    )

    output = io.StringIO()
    output.write("\uFEFF")  # BOM UTF-8 para Excel
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(
        [
            "Código",
            "Cédula",
            "Nombre y Apellido",
            "Sexo",
            "Cód. Municipio",
            "Municipio",
            "Cód. Parroquia",
            "Parroquia",
            "Centro de Votación",
            "Dirección",
            "Teléfono",
            "Correo",
            "Redes Sociales",
            "Comunidad",
            "Enlace",
            "Responsable Municipal",
            "Responsable de Comunidad",
            "Responsable CAL",
            "Responsable Local",
            "Comité de Activismo Local (CAL)",
            "Dirección del CAL",
        ]
    )
    for r in registros:
        writer.writerow(
            [
                r.get("codigo", ""),
                r.get("cedula", ""),
                r.get("nombre_apellido", ""),
                r.get("sexo", ""),
                r.get("codigo_municipio", ""),
                r.get("municipio", ""),
                r.get("codigo_parroquia", ""),
                r.get("parroquia", ""),
                r.get("centro_votacion", ""),
                r.get("direccion", ""),
                r.get("telefono", ""),
                r.get("correo", ""),
                r.get("redes_sociales", ""),
                r.get("comunidad", ""),
                r.get("enlace", ""),
                r.get("responsable_municipal", ""),
                r.get("responsable_comunidad", ""),
                r.get("responsable_cal", ""),
                r.get("responsable_local", ""),
                r.get("comite_activismo_local", ""),
                r.get("direccion_cal", ""),
            ]
        )

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="activistas_ap_aragua.csv"'
        },
    )


@app.get("/api/estadisticas")
def obtener_estadisticas(_: str = Depends(verify_token)) -> Dict[str, Any]:
    return calcular_estadisticas()

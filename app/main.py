import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app import config  # Carga .env antes que cualquier otro módulo interno

logger = config.configure_logging()

from fastapi import (  # noqa: E402
    Depends,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from app import auth, database, padron, reports  # noqa: E402
from app.models import (  # noqa: E402
    CATALOGO_GEOGRAFICO,
    ActivistaInput,
    BackupRestoreInput,
    BulkDeleteActivistasInput,
    BulkUpdateActivistasInput,
    ChangePasswordRequest,
    EstructuraInput,
    LoginRequest,
    LoteActivistasInput,
    UsuarioCreateInput,
    UsuarioUpdateInput,
    limpiar_cedula,
)

_MAX_IMPORT_BYTES = 10 * 1024 * 1024


def _extraer_filtros_dict(
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
) -> Dict[str, Optional[str]]:
    return {
        "cedula": cedula,
        "nombre": nombre,
        "codigo": codigo,
        "codigo_municipio": codigo_municipio,
        "codigo_parroquia": codigo_parroquia,
        "centro_votacion": centro_votacion,
        "cal": cal,
        "enlace": enlace,
        "responsable_cal": responsable_cal,
        "responsable_local": responsable_local,
        "responsable_comunidad": responsable_comunidad,
        "responsable_municipal": responsable_municipal,
        "comunidad": comunidad,
        "rol_electoral": rol_electoral,
        "estado_contacto": estado_contacto,
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.init_databases()
    auth.cargar_sesiones()
    auth.ensure_default_admin()
    yield


app = FastAPI(
    title="Sistema de Gestión Electoral - Avanzada Progresista Aragua",
    version="2.0.0",
    lifespan=lifespan,
    docs_url=None if config.IS_PRODUCTION else "/docs",
    redoc_url=None if config.IS_PRODUCTION else "/redoc",
    openapi_url=None if config.IS_PRODUCTION else "/openapi.json",
)


@app.middleware("http")
async def security_and_cache_middleware(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path

    # Cabeceras de seguridad
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    if config.IS_PRODUCTION or not path.startswith(("/docs", "/redoc", "/openapi.json")):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "font-src 'self' data:; "
            "connect-src 'self'; "
            "frame-ancestors 'none'"
        )

    # Caché inteligente
    if path == "/" or path.startswith(("/static/js/", "/static/src/")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    elif path.startswith("/static/vendor/") or path.endswith(".png"):
        response.headers["Cache-Control"] = "public, max-age=86400"

    return response


app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def serve_index() -> FileResponse:
    return FileResponse(
        str(config.STATIC_DIR / "index.html"),
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/api/health")
def health_check() -> Dict[str, Any]:
    return {"ok": True, "version": "2.0.0"}


@app.get("/api/auth/config")
def auth_config() -> Dict[str, Any]:
    return {
        "multi_usuario": auth.es_multi_usuario(),
        "idle_seconds": config.SESSION_IDLE_SECONDS,
    }


@app.post("/api/login")
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    _: None = Depends(auth.login_rate_limit_dep),
) -> Dict[str, Any]:
    usuario = auth.autenticar_credenciales(payload.username or "", payload.password)
    if not usuario:
        auth.registrar_fallo_login(request)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Clave o usuario de acceso incorrecto.",
        )

    auth.limpiar_fallos_login(request)
    token = auth.crear_sesion(usuario)

    direct_ip = request.client.host if request.client else ""
    is_https = request.url.scheme == "https" or (
        direct_ip in config.TRUSTED_PROXIES
        and request.headers.get("x-forwarded-proto", "").lower() == "https"
    )
    response.set_cookie(
        key=auth.COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=is_https,
        max_age=config.SESSION_TTL_SECONDS,
        path="/",
    )
    return {
        "ok": True,
        "token": token,
        "user": {
            "username": usuario["username"],
            "nombre": usuario.get("nombre", usuario["username"]),
            "rol": usuario.get("rol", "consulta"),
        },
    }


@app.post("/api/logout")
def logout(
    response: Response, user: Dict[str, Any] = Depends(auth.get_current_user)
) -> Dict[str, Any]:
    auth.revocar_sesion(user.get("token", ""))
    response.delete_cookie(key=auth.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(user: Dict[str, Any] = Depends(auth.get_current_user)) -> Dict[str, Any]:
    return {
        "username": user["username"],
        "nombre": user["nombre"],
        "rol": user["rol"],
        "multi_usuario": auth.es_multi_usuario(),
    }


@app.post("/api/auth/cambiar-clave")
def cambiar_clave(
    payload: ChangePasswordRequest,
    user: Dict[str, Any] = Depends(auth.get_current_user),
) -> Dict[str, Any]:
    u_db = database.obtener_usuario_cache(user["username"])
    if not u_db or not auth.verify_password(
        payload.password_actual, u_db.get("password_hash", "")
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La clave actual no es correcta.",
        )
    actualizado = dict(u_db)
    actualizado["password_hash"] = auth.hash_password(payload.password_nueva)
    actualizado["from_env"] = False
    database.guardar_usuario_db(actualizado)
    return {"ok": True}


# ==============================================================================
# GESTIÓN DE USUARIOS (SOLO ADMIN)
# ==============================================================================
@app.get("/api/usuarios")
def listar_usuarios(_: Dict[str, Any] = Depends(auth.require_roles("admin"))) -> Dict[str, Any]:
    items = database.listar_usuarios_cache()
    return {"total": len(items), "registros": items}


@app.post("/api/usuarios")
def crear_usuario(
    payload: UsuarioCreateInput,
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    if database.obtener_usuario_cache(payload.username):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"El usuario '{payload.username}' ya existe.",
        )
    guardado = database.guardar_usuario_db(
        {
            "username": payload.username,
            "nombre": payload.nombre,
            "rol": payload.rol,
            "activo": payload.activo,
            "from_env": False,
            "password_hash": auth.hash_password(payload.password),
        }
    )
    return {"ok": True, "usuario": guardado}


@app.put("/api/usuarios/{username}")
def actualizar_usuario(
    username: str,
    payload: UsuarioUpdateInput,
    admin_user: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    uname = username.strip().lower()
    existente = database.obtener_usuario_cache(uname)
    if not existente:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado."
        )

    nuevo_rol = payload.rol if payload.rol is not None else existente.get("rol")
    nuevo_activo = payload.activo if payload.activo is not None else existente.get("activo", True)

    # Evitar dejar el sistema sin ningún administrador activo
    admins_activos = [
        u
        for u in database.listar_usuarios_cache()
        if u.get("rol") == "admin" and u.get("activo", True)
    ]
    era_admin_activo = existente.get("rol") == "admin" and existente.get("activo", True)
    seguira_admin_activo = nuevo_rol == "admin" and nuevo_activo
    if era_admin_activo and not seguira_admin_activo and len(admins_activos) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Debe existir al menos un administrador activo en el sistema.",
        )
    if uname == admin_user["username"] and not nuevo_activo:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No puede deshabilitar su propio usuario mientras está conectado.",
        )

    actualizado = dict(existente)
    if payload.nombre is not None:
        actualizado["nombre"] = payload.nombre
    if payload.rol is not None:
        actualizado["rol"] = payload.rol
    if payload.activo is not None:
        actualizado["activo"] = payload.activo
    if payload.password:
        actualizado["password_hash"] = auth.hash_password(payload.password)
        actualizado["from_env"] = False

    guardado = database.guardar_usuario_db(actualizado)
    if not guardado["activo"] or payload.password:
        auth.revocar_sesiones_usuario(uname)
    return {"ok": True, "usuario": guardado}


@app.delete("/api/usuarios/{username}")
def eliminar_usuario(
    username: str,
    admin_user: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    uname = username.strip().lower()
    if uname == admin_user["username"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No puede eliminar su propio usuario.",
        )
    existente = database.obtener_usuario_cache(uname)
    if not existente:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado."
        )
    if existente.get("rol") == "admin" and existente.get("activo", True):
        admins_activos = [
            u
            for u in database.listar_usuarios_cache()
            if u.get("rol") == "admin" and u.get("activo", True)
        ]
        if len(admins_activos) <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No puede eliminar al único administrador activo.",
            )
    auth.revocar_sesiones_usuario(uname)
    database.eliminar_usuario_db(uname)
    return {"ok": True}


# ==============================================================================
# SISTEMA, GEOGRAFÍA Y PADRÓN CNE (SOLO LECTURA)
# ==============================================================================
@app.get("/api/estado-sistema")
def estado_sistema(_: Dict[str, Any] = Depends(auth.get_current_user)) -> Dict[str, Any]:
    return database.obtener_estado_sistema()


@app.get("/api/catalogo-geografico")
def catalogo_geografico(
    _: Dict[str, Any] = Depends(auth.get_current_user),
) -> List[Dict[str, Any]]:
    return CATALOGO_GEOGRAFICO


@app.get("/api/padron/buscar-nombre")
def buscar_padron_por_nombre(
    q: str = Query(..., min_length=2, max_length=100),
    codigo_municipio: Optional[str] = Query(default=""),
    codigo_parroquia: Optional[str] = Query(default=""),
    limit: int = Query(default=25, ge=1, le=50),
    _: Dict[str, Any] = Depends(auth.require_roles("admin", "transcriptor", "consulta")),
) -> Dict[str, Any]:
    resultados = padron.buscar_electores_por_nombre_sqlite(
        query=q,
        codigo_municipio=codigo_municipio or "",
        codigo_parroquia=codigo_parroquia or "",
        limit=limit,
    )
    return {"total": len(resultados), "registros": resultados}


@app.get("/api/padron/centros")
def listar_centros_padron(
    codigo_municipio: Optional[str] = Query(default=""),
    codigo_parroquia: Optional[str] = Query(default=""),
    q: Optional[str] = Query(default=""),
    limit: int = Query(default=80, ge=1, le=700),
    _: Dict[str, Any] = Depends(auth.get_current_user),
) -> Dict[str, Any]:
    centros = padron.listar_centros_cne(
        codigo_municipio=codigo_municipio or "",
        codigo_parroquia=codigo_parroquia or "",
        q=q or "",
        limit=limit,
    )
    return {"total": len(centros), "registros": centros}


@app.get("/api/padron/cobertura")
def obtener_cobertura_cne(
    codigo_municipio: Optional[str] = Query(default=""),
    codigo_parroquia: Optional[str] = Query(default=""),
    _: Dict[str, Any] = Depends(auth.require_roles("admin", "consulta")),
) -> Dict[str, Any]:
    return database.calcular_cobertura_cne(
        codigo_municipio=codigo_municipio or "",
        codigo_parroquia=codigo_parroquia or "",
    )


@app.get("/api/elector/{cedula}")
def consultar_elector(
    cedula: str, user: Dict[str, Any] = Depends(auth.get_current_user)
) -> Dict[str, Any]:
    ced_limpia = limpiar_cedula(cedula)
    if len(ced_limpia) < 5 or len(ced_limpia) > 12:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ingrese un número de cédula válido (entre 5 y 12 dígitos).",
        )

    activista = database.obtener_activista_cache(ced_limpia)
    if activista:
        # Si es transcriptor y la ficha no le pertenece, evitar exponer PII ajeno
        if (
            user.get("rol") == "transcriptor"
            and str(activista.get("creado_por") or "").lower() != user["username"]
        ):
            elector = padron.buscar_elector_sqlite(ced_limpia) or {}
            cod_mun = activista.get("codigo_municipio") or elector.get("codigo_municipio") or "01"
            return {
                "encontrado_en": "activistas",
                "modo_edicion": False,
                "datos": {
                    "cedula": ced_limpia,
                    "codigo": database.generar_codigo_planilla(cod_mun),
                    "nombre_apellido": elector.get("nombre_apellido") or activista.get("nombre_apellido", ""),
                    "codigo_municipio": cod_mun,
                    "municipio": activista.get("municipio", ""),
                    "codigo_parroquia": activista.get("codigo_parroquia", ""),
                    "parroquia": activista.get("parroquia", ""),
                    "centro_votacion": activista.get("centro_votacion", ""),
                    "cod_centro": activista.get("cod_centro", ""),
                    "mesa": activista.get("mesa", ""),
                    "fecha_nacimiento": activista.get("fecha_nacimiento", ""),
                },
            }
        return {
            "encontrado_en": "activistas",
            "modo_edicion": True,
            "datos": activista,
        }

    elector = padron.buscar_elector_sqlite(ced_limpia)
    if elector:
        cod_mun = elector.get("codigo_municipio") or "01"
        elector["codigo"] = database.generar_codigo_planilla(cod_mun)
        return {
            "encontrado_en": "padron",
            "modo_edicion": False,
            "datos": elector,
        }

    return {
        "encontrado_en": "ninguno",
        "modo_edicion": False,
        "datos": {
            "cedula": ced_limpia,
            "codigo": database.generar_codigo_planilla("01"),
        },
    }


# ==============================================================================
# ACTIVISTAS, EXPORTACIONES, IMPORTACIÓN Y ACCIONES EN BLOQUE
# ==============================================================================
@app.get("/api/activistas/codigo-siguiente/{codigo_municipio}")
def codigo_siguiente(
    codigo_municipio: str,
    representante: Optional[str] = Query(default=None),
    _: Dict[str, Any] = Depends(auth.require_roles("admin", "transcriptor")),
) -> Dict[str, str]:
    return {
        "codigo": database.generar_codigo_planilla(
            codigo_municipio, representante=representante
        )
    }


@app.get("/api/activistas/exportar-csv")
def exportar_csv(
    cedula: Optional[str] = Query(default=None),
    nombre: Optional[str] = Query(default=None),
    codigo: Optional[str] = Query(default=None),
    codigo_municipio: Optional[str] = Query(default=None),
    codigo_parroquia: Optional[str] = Query(default=None),
    centro_votacion: Optional[str] = Query(default=None),
    cal: Optional[str] = Query(default=None),
    enlace: Optional[str] = Query(default=None),
    responsable_cal: Optional[str] = Query(default=None),
    responsable_local: Optional[str] = Query(default=None),
    responsable_comunidad: Optional[str] = Query(default=None),
    responsable_municipal: Optional[str] = Query(default=None),
    comunidad: Optional[str] = Query(default=None),
    rol_electoral: Optional[str] = Query(default=None),
    estado_contacto: Optional[str] = Query(default=None),
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> StreamingResponse:
    filtros = _extraer_filtros_dict(
        cedula=cedula,
        nombre=nombre,
        codigo=codigo,
        codigo_municipio=codigo_municipio,
        codigo_parroquia=codigo_parroquia,
        centro_votacion=centro_votacion,
        cal=cal,
        enlace=enlace,
        responsable_cal=responsable_cal,
        responsable_local=responsable_local,
        responsable_comunidad=responsable_comunidad,
        responsable_municipal=responsable_municipal,
        comunidad=comunidad,
        rol_electoral=rol_electoral,
        estado_contacto=estado_contacto,
    )
    registros = database.filtrar_activistas(**filtros)
    csv_bytes = reports.generar_csv_bytes(registros)
    return StreamingResponse(
        iter([csv_bytes]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="activistas_ap_aragua.csv"'
        },
    )


@app.get("/api/activistas/exportar-xlsx")
def exportar_xlsx(
    cedula: Optional[str] = Query(default=None),
    nombre: Optional[str] = Query(default=None),
    codigo: Optional[str] = Query(default=None),
    codigo_municipio: Optional[str] = Query(default=None),
    codigo_parroquia: Optional[str] = Query(default=None),
    centro_votacion: Optional[str] = Query(default=None),
    cal: Optional[str] = Query(default=None),
    enlace: Optional[str] = Query(default=None),
    responsable_cal: Optional[str] = Query(default=None),
    responsable_local: Optional[str] = Query(default=None),
    responsable_comunidad: Optional[str] = Query(default=None),
    responsable_municipal: Optional[str] = Query(default=None),
    comunidad: Optional[str] = Query(default=None),
    rol_electoral: Optional[str] = Query(default=None),
    estado_contacto: Optional[str] = Query(default=None),
    destinatario: Optional[str] = Query(default=None),
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> StreamingResponse:
    filtros = _extraer_filtros_dict(
        cedula=cedula,
        nombre=nombre,
        codigo=codigo,
        codigo_municipio=codigo_municipio,
        codigo_parroquia=codigo_parroquia,
        centro_votacion=centro_votacion,
        cal=cal,
        enlace=enlace,
        responsable_cal=responsable_cal,
        responsable_local=responsable_local,
        responsable_comunidad=responsable_comunidad,
        responsable_municipal=responsable_municipal,
        comunidad=comunidad,
        rol_electoral=rol_electoral,
        estado_contacto=estado_contacto,
    )
    registros = database.filtrar_activistas(**filtros)
    stats = database.calcular_estadisticas(
        codigo_municipio=codigo_municipio or "",
        codigo_parroquia=codigo_parroquia or "",
    )
    cobertura = database.calcular_cobertura_cne(
        codigo_municipio=codigo_municipio or "",
        codigo_parroquia=codigo_parroquia or "",
    )
    partes_flt = [f"{k}: {v}" for k, v in filtros.items() if v]
    resumen_flt = ", ".join(partes_flt) if partes_flt else "Listado General (Aragua)"
    xlsx_bytes = reports.generar_excel_bytes(
        registros=registros,
        stats=stats,
        cobertura=cobertura,
        filtros_resumen=resumen_flt,
        destinatario=destinatario or "",
    )
    fecha_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return StreamingResponse(
        iter([xlsx_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="activistas_ap_aragua_{fecha_str}.xlsx"'
        },
    )


@app.post("/api/activistas/lote")
def guardar_activistas_lote(
    payload: LoteActivistasInput,
    user: Dict[str, Any] = Depends(auth.require_roles("admin", "transcriptor")),
) -> Dict[str, Any]:
    resultado = database.guardar_activistas_lote_db(
        [a.model_dump() for a in payload.activistas],
        actor=user["username"],
    )
    return {"ok": True, **resultado}


@app.post("/api/activistas/bulk-update")
def actualizar_activistas_bloque(
    payload: BulkUpdateActivistasInput,
    user: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    cambios = payload.model_dump(exclude={"cedulas"}, exclude_none=True)
    resultado = database.actualizar_activistas_masivo_db(
        cedulas=payload.cedulas, cambios=cambios, actor=user["username"]
    )
    return {"ok": True, **resultado}


@app.post("/api/activistas/bulk-delete")
def eliminar_activistas_bloque(
    payload: BulkDeleteActivistasInput,
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    resultado = database.eliminar_activistas_masivo_db(payload.cedulas)
    return {"ok": True, **resultado}


@app.post("/api/activistas/importar/preview")
async def importar_preview(
    file: UploadFile = File(...),
    _: Dict[str, Any] = Depends(auth.require_roles("admin", "transcriptor")),
) -> Dict[str, Any]:
    content = await file.read(_MAX_IMPORT_BYTES + 1)
    if len(content) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="El archivo supera el límite de 10 MB.",
        )
    try:
        resultado = reports.parsear_importacion(file.filename or "archivo.xlsx", content)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"ok": True, **resultado}


@app.get("/api/activistas")
def listar_activistas(
    cedula: Optional[str] = Query(default=None),
    nombre: Optional[str] = Query(default=None),
    codigo: Optional[str] = Query(default=None),
    codigo_municipio: Optional[str] = Query(default=None),
    codigo_parroquia: Optional[str] = Query(default=None),
    centro_votacion: Optional[str] = Query(default=None),
    cal: Optional[str] = Query(default=None),
    enlace: Optional[str] = Query(default=None),
    responsable_cal: Optional[str] = Query(default=None),
    responsable_local: Optional[str] = Query(default=None),
    responsable_comunidad: Optional[str] = Query(default=None),
    responsable_municipal: Optional[str] = Query(default=None),
    comunidad: Optional[str] = Query(default=None),
    rol_electoral: Optional[str] = Query(default=None),
    estado_contacto: Optional[str] = Query(default=None),
    user: Dict[str, Any] = Depends(auth.get_current_user),
) -> Dict[str, Any]:
    creado_por = user["username"] if user.get("rol") == "transcriptor" else None
    registros = database.filtrar_activistas(
        cedula=cedula,
        nombre=nombre,
        codigo=codigo,
        codigo_municipio=codigo_municipio,
        codigo_parroquia=codigo_parroquia,
        centro_votacion=centro_votacion,
        cal=cal,
        enlace=enlace,
        responsable_cal=responsable_cal,
        responsable_local=responsable_local,
        responsable_comunidad=responsable_comunidad,
        responsable_municipal=responsable_municipal,
        comunidad=comunidad,
        rol_electoral=rol_electoral,
        estado_contacto=estado_contacto,
        creado_por=creado_por,
    )
    return {"total": len(registros), "registros": registros}


@app.post("/api/activistas")
def guardar_activista(
    payload: ActivistaInput,
    user: Dict[str, Any] = Depends(auth.require_roles("admin", "transcriptor")),
) -> Dict[str, Any]:
    guardado = database.guardar_activista_db(
        payload.model_dump(), actor=user["username"]
    )
    return {"ok": True, "activista": guardado}


@app.delete("/api/activistas/{cedula}")
def eliminar_activista(
    cedula: str,
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    eliminado = database.eliminar_activista_db(cedula)
    if not eliminado:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Activista no encontrado.",
        )
    return {"ok": True}


# ==============================================================================
# PLANILLAS, ANALÍTICA Y CALIDAD DE DATOS
# ==============================================================================
@app.get("/api/planillas")
def listar_planillas(user: Dict[str, Any] = Depends(auth.get_current_user)) -> Dict[str, Any]:
    creado_por = user["username"] if user.get("rol") == "transcriptor" else None
    planillas = database.listar_planillas_resumen(creado_por=creado_por)
    return {"total": len(planillas), "registros": planillas}


@app.get("/api/estadisticas")
def obtener_estadisticas(
    codigo_municipio: Optional[str] = Query(default=""),
    codigo_parroquia: Optional[str] = Query(default=""),
    _: Dict[str, Any] = Depends(auth.require_roles("admin", "consulta")),
) -> Dict[str, Any]:
    return database.calcular_estadisticas(
        codigo_municipio=codigo_municipio or "",
        codigo_parroquia=codigo_parroquia or "",
    )


@app.get("/api/calidad-datos")
def obtener_calidad_datos(
    _: Dict[str, Any] = Depends(auth.require_roles("admin", "consulta")),
) -> Dict[str, Any]:
    return database.analizar_calidad_datos()


# ==============================================================================
# ESTRUCTURA Y RESPONSABLES
# ==============================================================================
@app.get("/api/estructura")
def listar_estructura(
    rol: Optional[str] = Query(default=None),
    _: Dict[str, Any] = Depends(auth.get_current_user),
) -> Dict[str, Any]:
    items = database.listar_estructura_cache(rol=rol)
    return {"total": len(items), "registros": items}


@app.post("/api/estructura")
def guardar_estructura(
    payload: EstructuraInput,
    _: Dict[str, Any] = Depends(auth.require_roles("admin", "transcriptor")),
) -> Dict[str, Any]:
    resultado = database.guardar_estructura_db(payload.model_dump())
    return {"ok": True, **resultado}


@app.delete("/api/estructura/{item_id}")
def eliminar_estructura(
    item_id: str,
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    resultado = database.eliminar_estructura_db(item_id)
    if not resultado["eliminado"]:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Registro de estructura no encontrado.",
        )
    return {"ok": True, **resultado}


# ==============================================================================
# RESPALDOS MANUALES Y AUTOMÁTICOS (SOLO ADMIN)
# ==============================================================================
@app.get("/api/backup")
def descargar_backup(
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> StreamingResponse:
    backup = database.exportar_backup_db()
    contenido = json.dumps(backup, ensure_ascii=False, indent=2)
    fecha_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return StreamingResponse(
        iter([contenido]),
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="respaldo_ap_aragua_{fecha_str}.json"'
        },
    )


@app.post("/api/backup/restore")
def restaurar_backup(
    payload: BackupRestoreInput,
    user: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    resultado = database.restaurar_backup_db(
        activistas_list=[a.model_dump() for a in payload.activistas],
        estructura_list=[e.model_dump() for e in payload.estructura],
        modo=payload.modo,
        actor=user["username"],
    )
    return {"ok": True, **resultado}


@app.get("/api/backups/automaticos")
def listar_backups_auto(
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> Dict[str, Any]:
    items = database.listar_backups_automaticos()
    return {"total": len(items), "registros": items}


@app.get("/api/backups/automaticos/{filename}")
def descargar_backup_auto(
    filename: str,
    _: Dict[str, Any] = Depends(auth.require_roles("admin")),
) -> FileResponse:
    path = database.leer_backup_automatico(filename)
    if not path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Respaldo automático no encontrado.",
        )
    return FileResponse(
        str(path),
        media_type="application/json; charset=utf-8",
        filename=path.name,
    )

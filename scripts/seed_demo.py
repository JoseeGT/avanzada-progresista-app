"""Puebla la base de datos Firestore de producción con datos de prueba realistas del padrón CNE."""

import logging
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app import auth, database, padron  # noqa: E402
from app.models import ActivistaInput  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("seed_demo")

# Municipios representativos de Aragua con sus responsables de demo
MUNICIPIOS_DEMO = [
    {
        "municipio_id": 1,  # Girardot
        "enlace": "CARLOS MENDOZA",
        "responsable_municipal": "MARIA FERNANDA RIVAS",
        "comunidad": "LAS DELICIAS",
        "cal": "CAL LAS DELICIAS CENTRO",
        "direccion_cal": "AV. LAS DELICIAS, SECTOR CENTRO",
    },
    {
        "municipio_id": 2,  # Santiago Mariño
        "enlace": "LUIS ALBERTO PEREZ",
        "responsable_municipal": "JOSE GREGORIO TORRES",
        "comunidad": "TURMERO CENTRO",
        "cal": "CAL TURMERO NORTE",
        "direccion_cal": "CALLE RIVAS, TURMERO",
    },
    {
        "municipio_id": 3,  # José Félix Ribas
        "enlace": "ANA KARINA GOMEZ",
        "responsable_municipal": "PEDRO PABLO CASTILLO",
        "comunidad": "LA VICTORIA SUR",
        "cal": "CAL LA VICTORIA",
        "direccion_cal": "AV. FRANCISCO DE LORETO",
    },
    {
        "municipio_id": 5,  # Sucre
        "enlace": "RICARDO ANTONIO DIAZ",
        "responsable_municipal": "ELENA BEATRIZ MORALES",
        "comunidad": "CAGUA CENTRO",
        "cal": "CAL CAGUA ESTE",
        "direccion_cal": "CALLE SUCRE, CAGUA",
    },
    {
        "municipio_id": 8,  # Mario Briceño Iragorry
        "enlace": "ANDREA VALENTINA SILVA",
        "responsable_municipal": "HECTOR RAFAEL ROJAS",
        "comunidad": "EL LIMON",
        "cal": "CAL EL LIMON",
        "direccion_cal": "AV. UNIVERSIDAD, EL LIMON",
    },
    {
        "municipio_id": 10,  # Libertador
        "enlace": "MIGUEL ANGEL HERNANDEZ",
        "responsable_municipal": "CARMEN LUCIA VARGAS",
        "comunidad": "PALO NEGRO",
        "cal": "CAL PALO NEGRO",
        "direccion_cal": "CALLE BOLIVAR, PALO NEGRO",
    },
]

ROLES_CICLO = [
    "COORDINADOR DE CENTRO",
    "TESTIGO PRINCIPAL",
    "TESTIGO SUPLENTE",
    "MOVILIZADOR",
    "MILITANTE",
    "MILITANTE",
    "MOVILIZADOR",
    "MILITANTE",
]

ESTADOS_CICLO = [
    "CONFIRMADO",
    "CONFIRMADO",
    "CONTACTADO",
    "POR CONTACTAR",
]

PREFIJOS_TLF = ["0412", "0414", "0424", "0416"]


def _obtener_cedulas_municipio(municipio_id: int, limite: int = 8) -> list[str]:
    conn = padron._conectar_ro()
    try:
        rows = conn.execute(
            """
            SELECT cedula FROM cne_electores
            WHERE municipio_id = ?
            LIMIT ?
            """,
            (municipio_id, limite),
        ).fetchall()
        return [str(r["cedula"]) for r in rows]
    finally:
        conn.close()


def main() -> int:
    database.init_databases()
    if database._MODO_PERSISTENCIA != "firestore":
        logger.error(
            "Firestore no está activo (modo actual: %s). "
            "Verifique serviceAccountKey.json antes de ejecutar.",
            database._MODO_PERSISTENCIA,
        )
        return 1

    total_cargados = 0
    for idx_mun, cfg in enumerate(MUNICIPIOS_DEMO):
        cedulas = _obtener_cedulas_municipio(cfg["municipio_id"], limite=8)
        if not cedulas:
            logger.warning("Sin electores para municipio_id=%s", cfg["municipio_id"])
            continue

        lote = []
        resp_cal = ""
        resp_com = ""
        resp_loc = ""

        for i, ced in enumerate(cedulas):
            elector = padron.buscar_elector_sqlite(ced)
            if not elector:
                continue

            if i == 0:
                resp_cal = elector["nombre_apellido"]
            if i == 1:
                resp_com = elector["nombre_apellido"]
            if i == 2:
                resp_loc = elector["nombre_apellido"]

            prefijo = PREFIJOS_TLF[(idx_mun + i) % len(PREFIJOS_TLF)]
            tlf = f"{prefijo}-{100 + idx_mun * 10 + i:03d}{2000 + i * 111:04d}"

            modelo = ActivistaInput(
                cedula=elector["cedula"],
                nombre_apellido=elector["nombre_apellido"],
                sexo=elector["sexo"],
                codigo_municipio=elector["codigo_municipio"],
                municipio=elector["municipio"],
                codigo_parroquia=elector["codigo_parroquia"],
                parroquia=elector["parroquia"],
                centro_votacion=elector["centro_votacion"],
                cod_centro=elector["cod_centro"],
                mesa=elector["mesa"],
                fecha_nacimiento=elector["fecha_nacimiento"],
                direccion=f"SECTOR {cfg['comunidad']}, CASA #{10 + i}",
                telefono=tlf,
                comunidad=cfg["comunidad"],
                enlace=cfg["enlace"],
                responsable_municipal=cfg["responsable_municipal"],
                responsable_comunidad=resp_com or cfg["responsable_municipal"],
                responsable_cal=resp_cal or cfg["enlace"],
                responsable_local=resp_loc or resp_cal or cfg["enlace"],
                comite_activismo_local=cfg["cal"],
                direccion_cal=cfg["direccion_cal"],
                rol_electoral=ROLES_CICLO[i % len(ROLES_CICLO)],
                estado_contacto=ESTADOS_CICLO[i % len(ESTADOS_CICLO)],
            )
            lote.append(modelo.model_dump())

        if lote:
            res = database.guardar_activistas_lote_db(lote, actor="seed_demo")
            total_cargados += res["total_procesados"]
            logger.info(
                "Municipio %s: %d activistas cargados (código %s).",
                lote[0]["municipio"],
                res["total_procesados"],
                lote[0].get("codigo") or "auto",
            )

    # Usuarios de demostración para probar roles
    demo_users = [
        ("transcriptor_demo", "DemoTrans2026!", "transcriptor", "Transcriptor de Prueba"),
        ("consulta_demo", "DemoConsulta2026!", "consulta", "Consultor de Prueba"),
    ]
    for uname, pwd, rol, nombre in demo_users:
        if not database.obtener_usuario_cache(uname):
            database.guardar_usuario_db(
                {
                    "username": uname,
                    "password_hash": auth.hash_password(pwd),
                    "rol": rol,
                    "nombre_completo": nombre,
                    "activo": True,
                }
            )
            logger.info("Usuario de prueba creado en Firestore: %s (%s)", uname, rol)

    logger.info(
        "Seed completado en Firestore: %d activistas, %d estructura, %d usuarios.",
        len(database.ACTIVISTAS_CACHE),
        len(database.ESTRUCTURA_CACHE),
        len(database.USUARIOS_CACHE),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

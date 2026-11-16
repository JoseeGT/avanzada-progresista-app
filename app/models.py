import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field, field_validator


CATALOGO_GEOGRAFICO: List[Dict[str, Any]] = [
    {
        "codigo": "01",
        "nombre": "Girardot",
        "parroquias": [
            {"codigo": "01", "nombre": "Pedro José Ovalles"},
            {"codigo": "02", "nombre": "Joaquín Crespo"},
            {"codigo": "03", "nombre": "José Casanova Godoy"},
            {"codigo": "04", "nombre": "Andrés Eloy Blanco"},
            {"codigo": "05", "nombre": "Los Tacarigua"},
            {"codigo": "06", "nombre": "Madre María de San José"},
            {"codigo": "07", "nombre": "Las Delicias"},
            {"codigo": "08", "nombre": "Choroní"},
        ],
    },
    {
        "codigo": "02",
        "nombre": "Mario Briceño Iragorry",
        "parroquias": [
            {"codigo": "01", "nombre": "El Limón"},
            {"codigo": "02", "nombre": "Caña de Azúcar"},
        ],
    },
    {
        "codigo": "03",
        "nombre": "Santiago Mariño",
        "parroquias": [
            {"codigo": "01", "nombre": "Turmero"},
            {"codigo": "02", "nombre": "Alfredo Pacheco Miranda"},
            {"codigo": "03", "nombre": "Samán de Güere"},
            {"codigo": "04", "nombre": "Chuao"},
            {"codigo": "05", "nombre": "Pedro Arévalo Aponte"},
        ],
    },
    {
        "codigo": "04",
        "nombre": "Francisco Linares Alcántara",
        "parroquias": [
            {"codigo": "01", "nombre": "Santa Rita"},
            {"codigo": "02", "nombre": "Francisco de Miranda"},
            {"codigo": "03", "nombre": "Monseñor Feliciano González"},
        ],
    },
    {
        "codigo": "05",
        "nombre": "Libertador",
        "parroquias": [
            {"codigo": "01", "nombre": "Palo Negro"},
            {"codigo": "02", "nombre": "San Martín de Porres"},
        ],
    },
    {
        "codigo": "06",
        "nombre": "José Ángel Lamas",
        "parroquias": [
            {"codigo": "01", "nombre": "Santa Cruz de Aragua"},
        ],
    },
    {
        "codigo": "07",
        "nombre": "Sucre",
        "parroquias": [
            {"codigo": "01", "nombre": "Cagua"},
            {"codigo": "02", "nombre": "Bella Vista"},
        ],
    },
    {
        "codigo": "08",
        "nombre": "Zamora",
        "parroquias": [
            {"codigo": "01", "nombre": "Villa de Cura"},
            {"codigo": "02", "nombre": "Magdaleno"},
            {"codigo": "03", "nombre": "San Francisco de Asís"},
            {"codigo": "04", "nombre": "Valles de Tucutunemo"},
            {"codigo": "05", "nombre": "Augusto Mijares"},
        ],
    },
    {
        "codigo": "09",
        "nombre": "San Sebastián",
        "parroquias": [
            {"codigo": "01", "nombre": "San Sebastián de los Reyes"},
        ],
    },
    {
        "codigo": "10",
        "nombre": "San Casimiro",
        "parroquias": [
            {"codigo": "01", "nombre": "San Casimiro"},
            {"codigo": "02", "nombre": "Guiripa"},
            {"codigo": "03", "nombre": "Ollas de Caramacate"},
            {"codigo": "04", "nombre": "Valle Morín"},
        ],
    },
    {
        "codigo": "11",
        "nombre": "Camatagua",
        "parroquias": [
            {"codigo": "01", "nombre": "Camatagua"},
            {"codigo": "02", "nombre": "Carmen de Cura"},
        ],
    },
    {
        "codigo": "12",
        "nombre": "Urdaneta",
        "parroquias": [
            {"codigo": "01", "nombre": "Barbacoas"},
            {"codigo": "02", "nombre": "Las Peñitas"},
            {"codigo": "03", "nombre": "San Francisco de Cara"},
            {"codigo": "04", "nombre": "Taguay"},
        ],
    },
    {
        "codigo": "13",
        "nombre": "José Félix Ribas",
        "parroquias": [
            {"codigo": "01", "nombre": "Juan Vicente Bolívar"},
            {"codigo": "02", "nombre": "Castor Nieves Ríos"},
            {"codigo": "03", "nombre": "Las Guacamayas"},
            {"codigo": "04", "nombre": "Pao de Zárate"},
            {"codigo": "05", "nombre": "Zuata"},
        ],
    },
    {
        "codigo": "14",
        "nombre": "José Rafael Revenga",
        "parroquias": [
            {"codigo": "01", "nombre": "El Consejo"},
        ],
    },
    {
        "codigo": "15",
        "nombre": "Santos Michelena",
        "parroquias": [
            {"codigo": "01", "nombre": "Las Tejerías"},
            {"codigo": "02", "nombre": "Tiara"},
        ],
    },
    {
        "codigo": "16",
        "nombre": "Bolívar",
        "parroquias": [
            {"codigo": "01", "nombre": "Bolívar (San Mateo)"},
        ],
    },
    {
        "codigo": "17",
        "nombre": "Tovar",
        "parroquias": [
            {"codigo": "01", "nombre": "Tovar (Colonia Tovar)"},
        ],
    },
    {
        "codigo": "18",
        "nombre": "Ocumare de la Costa de Oro",
        "parroquias": [
            {"codigo": "01", "nombre": "Ocumare de la Costa"},
        ],
    },
]


def normalizar_texto(texto: Optional[str]) -> str:
    """Elimina tildes/diacríticos, colapsa espacios y convierte a MAYÚSCULAS."""
    if not texto:
        return ""
    sin_tildes = "".join(
        c for c in unicodedata.normalize("NFKD", str(texto)) if not unicodedata.combining(c)
    )
    return re.sub(r"\s+", " ", sin_tildes).strip().upper()


def limpiar_cedula(valor: Optional[str]) -> str:
    """Deja únicamente dígitos numéricos en la cédula venezolana."""
    if not valor:
        return ""
    return re.sub(r"\D", "", str(valor))


def obtener_municipio_por_codigo(codigo_municipio: str) -> Optional[Dict[str, Any]]:
    """Retorna el diccionario del municipio oficial dado su código (01-18)."""
    cod = str(codigo_municipio).strip().zfill(2) if codigo_municipio else ""
    for mun in CATALOGO_GEOGRAFICO:
        if mun["codigo"] == cod:
            return mun
    return None


MUNICIPIO_ALIASES: Dict[str, str] = {
    "JOSE R REVENGA": "14",
    "MARIO B IRAGORRY": "02",
    "FRANCISCO LINARES": "04",
    "OCUMARE D L COSTA": "18",
}

PARROQUIA_ALIASES: Dict[Tuple[str, str], str] = {
    ("01", "MADRE MA DE SAN JOSE"): "06",
    ("04", "MONS FELICIANO G"): "03",
}


def mapear_geografia_cne(
    municipio_raw: Optional[str], parroquia_raw: Optional[str]
) -> Tuple[str, str, str, str]:
    """
    Compara sin tildes/mayúsculas el municipio y parroquia del SQLite CNE
    y los mapea a los códigos y nombres exactos del catálogo oficial.
    Retorna: (codigo_municipio, nombre_municipio, codigo_parroquia, nombre_parroquia)
    """
    mun_norm = normalizar_texto(municipio_raw)
    par_norm = normalizar_texto(parroquia_raw)

    # Limpiar prefijos comunes del CNE como "MP.", "MP. ", "PQ."
    mun_norm = re.sub(r"^(MUNICIPIO|MP\.?|MPIO\.?)\s*", "", mun_norm)
    par_norm = re.sub(r"^(PARROQUIA|PQ\.?|PRQ\.?)\s*", "", par_norm)

    mun_match = None
    if mun_norm in MUNICIPIO_ALIASES:
        mun_match = obtener_municipio_por_codigo(MUNICIPIO_ALIASES[mun_norm])

    if not mun_match:
        for mun in CATALOGO_GEOGRAFICO:
            cat_mun_norm = normalizar_texto(mun["nombre"])
            if mun_norm and (
                mun_norm == cat_mun_norm
                or mun_norm in cat_mun_norm
                or cat_mun_norm in mun_norm
            ):
                mun_match = mun
                break

    if not mun_match:
        return ("", municipio_raw.strip() if municipio_raw else "", "", parroquia_raw.strip() if parroquia_raw else "")

    par_match = None
    alias_par_cod = PARROQUIA_ALIASES.get((mun_match["codigo"], par_norm))
    if alias_par_cod:
        for par in mun_match["parroquias"]:
            if par["codigo"] == alias_par_cod:
                par_match = par
                break

    if not par_match:
        for par in mun_match["parroquias"]:
            cat_par_norm = normalizar_texto(par["nombre"])
            # Comparar también sin texto entre paréntesis (ej. "Bolívar (San Mateo)" -> "BOLIVAR")
            cat_par_base = re.sub(r"\s*\([^)]*\)", "", cat_par_norm).strip()
            if par_norm and (
                par_norm == cat_par_norm
                or par_norm == cat_par_base
                or par_norm in cat_par_norm
                or cat_par_norm in par_norm
                or (cat_par_base and (par_norm in cat_par_base or cat_par_base in par_norm))
            ):
                par_match = par
                break

    if par_match:
        return (
            mun_match["codigo"],
            mun_match["nombre"],
            par_match["codigo"],
            par_match["nombre"],
        )

    return (
        mun_match["codigo"],
        mun_match["nombre"],
        "",
        parroquia_raw.strip() if parroquia_raw else "",
    )


class LoginRequest(BaseModel):
    password: str = Field(..., min_length=1)


class ActivistaInput(BaseModel):
    cedula: str = Field(..., min_length=4, max_length=15)
    codigo: Optional[str] = Field(default="")
    nombre_apellido: str = Field(..., min_length=2, max_length=150)
    sexo: Optional[str] = Field(default="")
    codigo_municipio: str = Field(..., min_length=1, max_length=4)
    municipio: Optional[str] = Field(default="")
    codigo_parroquia: str = Field(..., min_length=1, max_length=4)
    parroquia: Optional[str] = Field(default="")
    centro_votacion: Optional[str] = Field(default="")
    direccion: Optional[str] = Field(default="")
    telefono: Optional[str] = Field(default="")
    correo: Optional[str] = Field(default="")
    redes_sociales: Optional[str] = Field(default="")
    comunidad: Optional[str] = Field(default="")
    enlace: Optional[str] = Field(default="")
    responsable_municipal: Optional[str] = Field(default="")
    responsable_comunidad: Optional[str] = Field(default="")
    responsable_cal: Optional[str] = Field(default="")
    responsable_local: Optional[str] = Field(default="")
    comite_activismo_local: Optional[str] = Field(default="")
    direccion_cal: Optional[str] = Field(default="")

    @field_validator("cedula", mode="before")
    @classmethod
    def validar_cedula(cls, v: Any) -> str:
        limpia = limpiar_cedula(str(v) if v is not None else "")
        if len(limpia) < 5 or len(limpia) > 12:
            raise ValueError("La cédula debe contener entre 5 y 12 dígitos numéricos.")
        return limpia

    @field_validator("sexo", mode="before")
    @classmethod
    def validar_sexo(cls, v: Any) -> str:
        val = str(v or "").strip().upper()
        if val in ("MASCULINO", "HOMBRE", "M", "H"):
            return "H" if val in ("HOMBRE", "H") else ("M" if val == "M" else "H")
        if val in ("FEMENINO", "MUJER", "F"):
            return "M"
        return val[:1] if val else ""

    @field_validator(
        "nombre_apellido",
        "centro_votacion",
        "direccion",
        "direccion_cal",
        "telefono",
        "correo",
        "redes_sociales",
        mode="before",
    )
    @classmethod
    def limpiar_espacios(cls, v: Any) -> str:
        return re.sub(r"\s+", " ", str(v or "")).strip()

    @field_validator("codigo", mode="before")
    @classmethod
    def normalizar_codigo_planilla(cls, v: Any) -> str:
        return re.sub(r"\s+", "", str(v or "")).strip().upper()

    @field_validator(
        "comunidad",
        "enlace",
        "responsable_municipal",
        "responsable_comunidad",
        "responsable_cal",
        "responsable_local",
        "comite_activismo_local",
        mode="before",
    )
    @classmethod
    def sanitizar_mayusculas(cls, v: Any) -> str:
        """Convierte automáticamente a MAYÚSCULAS SIN ESPACIOS EXTRA para evitar duplicados."""
        return re.sub(r"\s+", " ", str(v or "")).strip().upper()

    @field_validator("codigo_municipio", "codigo_parroquia", mode="before")
    @classmethod
    def normalizar_codigo_geo(cls, v: Any) -> str:
        s = str(v or "").strip()
        return s.zfill(2) if s.isdigit() else s


class LoteActivistasInput(BaseModel):
    activistas: List[ActivistaInput] = Field(..., min_length=1, max_length=100)

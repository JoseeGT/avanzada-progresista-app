import re
import unicodedata
from typing import Any, Dict, List, Literal, Optional, Tuple
from pydantic import BaseModel, Field, field_validator, model_validator


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

_MAPA_TILDES_ES = str.maketrans("ÁÉÍÓÚÜÀÈÌÒÙÂÊÎÔÛ", "AEIOUUAEIOUAEIOU")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_USERNAME_RE = re.compile(r"^[a-z0-9._-]{3,32}$")

ROLES_ELECTORALES: Tuple[str, ...] = (
    "",
    "MILITANTE",
    "TESTIGO PRINCIPAL",
    "TESTIGO SUPLENTE",
    "COORDINADOR DE CENTRO",
    "MOVILIZADOR",
)

ESTADOS_CONTACTO: Tuple[str, ...] = (
    "",
    "POR CONTACTAR",
    "CONTACTADO",
    "CONFIRMADO",
)


def normalizar_texto(texto: Optional[str]) -> str:
    """Elimina tildes/diacríticos, colapsa espacios y convierte a MAYÚSCULAS."""
    if not texto:
        return ""
    sin_tildes = "".join(
        c for c in unicodedata.normalize("NFKD", str(texto)) if not unicodedata.combining(c)
    )
    return re.sub(r"\s+", " ", sin_tildes).strip().upper()


def normalizar_clave_es(texto: Optional[str]) -> str:
    """Normaliza a MAYÚSCULAS sin tildes en vocales, preservando la letra Ñ."""
    if not texto:
        return ""
    nfc = unicodedata.normalize("NFC", str(texto))
    colapsado = re.sub(r"\s+", " ", nfc).strip().upper()
    return colapsado.translate(_MAPA_TILDES_ES)


def limpiar_cedula(valor: Optional[str]) -> str:
    """Deja únicamente dígitos numéricos en la cédula venezolana."""
    if not valor:
        return ""
    return re.sub(r"\D", "", str(valor))


def normalizar_sexo(valor: Any, estricto: bool = True) -> str:
    """Normaliza el campo sexo a 'H', 'M' o '' según la convención del sistema."""
    val = normalizar_texto(str(valor or ""))
    if not val:
        return ""
    if val in ("H", "HOMBRE", "MASCULINO"):
        return "H"
    if val in ("M", "MUJER", "FEMENINO", "F"):
        return "M"
    if estricto:
        raise ValueError("Sexo inválido. Use H (Hombre) o M (Mujer).")
    return ""


def normalizar_codigo_representante(valor: Optional[str]) -> str:
    """Normaliza el Nº/Código de representante (ej. '1' -> '01', 'AP-01-03' -> '03')."""
    val = re.sub(r"\s+", "", str(valor or "")).strip().upper()
    if not val:
        return ""
    match = re.match(r"^(?:AP-)?\d{1,2}-([A-Z0-9]+)$", val)
    if match:
        val = match.group(1)
    if val.isdigit():
        return val.zfill(2) if len(val) <= 2 else val
    return val


def formatear_codigo_planilla(valor: Optional[str]) -> str:
    """Normaliza el código de planilla al formato AP-{MUNICIPIO}-{REPRESENTANTE} (ej. AP-01-01)."""
    codigo = re.sub(r"\s+", "", str(valor or "")).strip().upper()
    if not codigo or re.match(r"^AP-\d{1,2}-?$", codigo):
        return ""
    match = re.match(r"^(?:AP-)?(\d{1,2})-(\d{1,4})$", codigo)
    if match:
        mun = str(int(match.group(1))).zfill(2)
        rep_raw = match.group(2)
        rep = str(int(rep_raw)).zfill(2) if len(rep_raw) <= 2 else rep_raw
        return f"AP-{mun}-{rep}"
    return codigo


def normalizar_telefono_venezolano(valor: Optional[str], estricto: bool = True) -> str:
    """Normaliza teléfonos venezolanos a 11 dígitos (04XX/02XX) y valida su longitud."""
    if not valor:
        return ""
    digitos = re.sub(r"\D", "", str(valor))
    if not digitos:
        return ""
    if digitos.startswith("58") and len(digitos) == 12:
        digitos = "0" + digitos[2:]
    elif digitos[0] in ("4", "2") and len(digitos) == 10:
        digitos = "0" + digitos
    if estricto and (
        len(digitos) < 10
        or len(digitos) > 15
        or (digitos.startswith("0") and len(digitos) != 11)
    ):
        raise ValueError("El teléfono debe tener 11 dígitos (ej. 04121234567).")
    return digitos


def obtener_municipio_por_codigo(codigo_municipio: str) -> Optional[Dict[str, Any]]:
    """Retorna el diccionario del municipio oficial dado su código (01-18)."""
    cod = str(codigo_municipio).strip().zfill(2) if codigo_municipio else ""
    for mun in CATALOGO_GEOGRAFICO:
        if mun["codigo"] == cod:
            return mun
    return None


def validar_parroquia_en_municipio(
    codigo_municipio: str, codigo_parroquia: str
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Valida que el municipio exista y que la parroquia pertenezca a ese municipio."""
    mun = obtener_municipio_por_codigo(codigo_municipio)
    if not mun:
        return None, None
    cod_par = str(codigo_parroquia or "").strip().zfill(2)
    for par in mun["parroquias"]:
        if par["codigo"] == cod_par:
            return mun, par
    return mun, None


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
        return (
            "",
            municipio_raw.strip() if municipio_raw else "",
            "",
            parroquia_raw.strip() if parroquia_raw else "",
        )

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
    username: Optional[str] = Field(default="")
    password: str = Field(..., min_length=1)


class ChangePasswordRequest(BaseModel):
    password_actual: str = Field(..., min_length=1)
    password_nueva: str = Field(..., min_length=6, max_length=128)


class UsuarioCreateInput(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    nombre: str = Field(..., min_length=2, max_length=100)
    rol: Literal["admin", "transcriptor", "consulta"]
    password: str = Field(..., min_length=6, max_length=128)
    activo: bool = Field(default=True)

    @field_validator("username", mode="before")
    @classmethod
    def validar_username(cls, v: Any) -> str:
        val = str(v or "").strip().lower()
        if not _USERNAME_RE.match(val):
            raise ValueError(
                "El usuario debe tener entre 3 y 32 caracteres (a-z, 0-9, '.', '_' o '-')."
            )
        return val

    @field_validator("nombre", mode="before")
    @classmethod
    def sanitizar_nombre_usuario(cls, v: Any) -> str:
        limpio = re.sub(r"\s+", " ", str(v or "")).strip()
        if len(limpio) < 2:
            raise ValueError("El nombre debe tener al menos 2 caracteres.")
        return limpio


class UsuarioUpdateInput(BaseModel):
    nombre: Optional[str] = Field(default=None, min_length=2, max_length=100)
    rol: Optional[Literal["admin", "transcriptor", "consulta"]] = Field(default=None)
    password: Optional[str] = Field(default=None, min_length=6, max_length=128)
    activo: Optional[bool] = Field(default=None)

    @field_validator("nombre", mode="before")
    @classmethod
    def sanitizar_nombre_opt(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        limpio = re.sub(r"\s+", " ", str(v)).strip()
        if len(limpio) < 2:
            raise ValueError("El nombre debe tener al menos 2 caracteres.")
        return limpio


class _ActivistaBase(BaseModel):
    cedula: str = Field(..., min_length=4, max_length=15)
    codigo: Optional[str] = Field(default="")
    nombre_apellido: str = Field(..., min_length=2, max_length=150)
    sexo: Optional[str] = Field(default="")
    codigo_municipio: str = Field(..., min_length=1, max_length=4)
    municipio: Optional[str] = Field(default="")
    codigo_parroquia: str = Field(..., min_length=1, max_length=4)
    parroquia: Optional[str] = Field(default="")
    centro_votacion: Optional[str] = Field(default="")
    cod_centro: Optional[str] = Field(default="")
    mesa: Optional[str] = Field(default="")
    fecha_nacimiento: Optional[str] = Field(default="")
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
    rol_electoral: Optional[str] = Field(default="")
    estado_contacto: Optional[str] = Field(default="")

    @field_validator("cedula", mode="before")
    @classmethod
    def validar_cedula(cls, v: Any) -> str:
        limpia = limpiar_cedula(str(v) if v is not None else "")
        if len(limpia) < 5 or len(limpia) > 12:
            raise ValueError("La cédula debe contener entre 5 y 12 dígitos numéricos.")
        return limpia

    @field_validator(
        "nombre_apellido",
        "centro_votacion",
        "cod_centro",
        "fecha_nacimiento",
        "direccion",
        "direccion_cal",
        "correo",
        "redes_sociales",
        mode="before",
    )
    @classmethod
    def limpiar_espacios(cls, v: Any) -> str:
        return re.sub(r"\s+", " ", str(v or "")).strip()

    @field_validator("mesa", mode="before")
    @classmethod
    def limpiar_mesa(cls, v: Any) -> str:
        return re.sub(r"\D", "", str(v or ""))

    @field_validator("codigo", mode="before")
    @classmethod
    def normalizar_codigo_planilla(cls, v: Any) -> str:
        return formatear_codigo_planilla(str(v or ""))

    @field_validator(
        "comunidad",
        "enlace",
        "responsable_municipal",
        "responsable_comunidad",
        "responsable_cal",
        "responsable_local",
        "comite_activismo_local",
        "rol_electoral",
        "estado_contacto",
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


class ActivistaInput(_ActivistaBase):
    @field_validator("sexo", mode="before")
    @classmethod
    def validar_sexo_estricto(cls, v: Any) -> str:
        return normalizar_sexo(v, estricto=True)

    @field_validator("telefono", mode="before")
    @classmethod
    def validar_telefono(cls, v: Any) -> str:
        return normalizar_telefono_venezolano(str(v or ""), estricto=True)

    @field_validator("correo")
    @classmethod
    def validar_correo_opcional(cls, v: str) -> str:
        if v and not _EMAIL_RE.match(v):
            raise ValueError("El formato del correo electrónico no es válido.")
        return v

    @model_validator(mode="after")
    def validar_geografia_oficial(self) -> "ActivistaInput":
        mun, par = validar_parroquia_en_municipio(
            self.codigo_municipio, self.codigo_parroquia
        )
        if not mun:
            raise ValueError(
                f"Código de municipio inválido ({self.codigo_municipio}). Debe estar entre 01 y 18."
            )
        if not par:
            raise ValueError(
                f"La parroquia '{self.codigo_parroquia}' no pertenece al municipio {mun['nombre']} ({mun['codigo']})."
            )
        self.codigo_municipio = mun["codigo"]
        self.municipio = mun["nombre"]
        self.codigo_parroquia = par["codigo"]
        self.parroquia = par["nombre"]
        return self


class ActivistaBackupInput(_ActivistaBase):
    @field_validator("sexo", mode="before")
    @classmethod
    def validar_sexo_backup(cls, v: Any) -> str:
        return normalizar_sexo(v, estricto=False)

    @field_validator("telefono", mode="before")
    @classmethod
    def normalizar_telefono_backup(cls, v: Any) -> str:
        return normalizar_telefono_venezolano(str(v or ""), estricto=False)


class LoteActivistasInput(BaseModel):
    activistas: List[ActivistaInput] = Field(..., min_length=1, max_length=500)


class BulkUpdateActivistasInput(BaseModel):
    cedulas: List[str] = Field(..., min_length=1, max_length=500)
    codigo: Optional[str] = Field(default=None)
    comunidad: Optional[str] = Field(default=None)
    comite_activismo_local: Optional[str] = Field(default=None)
    direccion_cal: Optional[str] = Field(default=None)
    enlace: Optional[str] = Field(default=None)
    responsable_cal: Optional[str] = Field(default=None)
    responsable_local: Optional[str] = Field(default=None)
    responsable_comunidad: Optional[str] = Field(default=None)
    responsable_municipal: Optional[str] = Field(default=None)
    rol_electoral: Optional[str] = Field(default=None)
    estado_contacto: Optional[str] = Field(default=None)

    @field_validator("cedulas", mode="before")
    @classmethod
    def limpiar_cedulas_lista(cls, v: Any) -> List[str]:
        if not isinstance(v, list):
            raise ValueError("Lista de cédulas inválida.")
        limpias: List[str] = []
        vistas = set()
        for item in v:
            c = limpiar_cedula(str(item or ""))
            if 5 <= len(c) <= 12 and c not in vistas:
                vistas.add(c)
                limpias.append(c)
        if not limpias:
            raise ValueError("Debe seleccionar al menos una cédula válida.")
        return limpias

    @field_validator("codigo", mode="before")
    @classmethod
    def norm_codigo_opt(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        return formatear_codigo_planilla(str(v))

    @field_validator("direccion_cal", mode="before")
    @classmethod
    def norm_dir_cal_opt(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        return re.sub(r"\s+", " ", str(v)).strip()

    @field_validator(
        "comunidad",
        "comite_activismo_local",
        "enlace",
        "responsable_cal",
        "responsable_local",
        "responsable_comunidad",
        "responsable_municipal",
        "rol_electoral",
        "estado_contacto",
        mode="before",
    )
    @classmethod
    def norm_mayus_opt(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        return re.sub(r"\s+", " ", str(v)).strip().upper()


class BulkDeleteActivistasInput(BaseModel):
    cedulas: List[str] = Field(..., min_length=1, max_length=500)

    @field_validator("cedulas", mode="before")
    @classmethod
    def limpiar_cedulas_del(cls, v: Any) -> List[str]:
        if not isinstance(v, list):
            raise ValueError("Lista de cédulas inválida.")
        limpias = []
        vistas = set()
        for item in v:
            c = limpiar_cedula(str(item or ""))
            if 5 <= len(c) <= 12 and c not in vistas:
                vistas.add(c)
                limpias.append(c)
        if not limpias:
            raise ValueError("Debe seleccionar al menos una cédula válida.")
        return limpias


ROLES_ESTRUCTURA: Tuple[str, ...] = (
    "enlace",
    "responsable_local",
    "responsable_comunidad",
    "responsable_municipal",
    "responsable_cal",
)


class _EstructuraBase(BaseModel):
    id_anterior: Optional[str] = Field(default="")
    rol: Literal[
        "enlace",
        "responsable_local",
        "responsable_comunidad",
        "responsable_municipal",
        "responsable_cal",
    ]
    nombre: str = Field(..., min_length=2, max_length=150)
    cedula: Optional[str] = Field(default="")
    telefono: Optional[str] = Field(default="")
    codigo_municipio: Optional[str] = Field(default="")
    municipio: Optional[str] = Field(default="")
    codigo_representante: Optional[str] = Field(default="")

    @field_validator("nombre", mode="before")
    @classmethod
    def sanitizar_nombre_estructura(cls, v: Any) -> str:
        limpio = re.sub(r"\s+", " ", str(v or "")).strip().upper()
        if len(limpio) < 2:
            raise ValueError("El nombre debe tener al menos 2 caracteres.")
        return limpio

    @field_validator("cedula", mode="before")
    @classmethod
    def sanitizar_cedula_estructura(cls, v: Any) -> str:
        return limpiar_cedula(str(v or ""))

    @field_validator("codigo_municipio", mode="before")
    @classmethod
    def normalizar_mun_estructura(cls, v: Any) -> str:
        s = str(v or "").strip()
        return s.zfill(2) if s.isdigit() else s

    @field_validator("codigo_representante", mode="before")
    @classmethod
    def sanitizar_codigo_rep_estructura(cls, v: Any) -> str:
        return normalizar_codigo_representante(str(v or ""))


class EstructuraInput(_EstructuraBase):
    @field_validator("telefono", mode="before")
    @classmethod
    def validar_telefono_estructura(cls, v: Any) -> str:
        return normalizar_telefono_venezolano(str(v or ""), estricto=True)

    @model_validator(mode="after")
    def validar_municipio_estructura(self) -> "EstructuraInput":
        if self.codigo_municipio:
            mun = obtener_municipio_por_codigo(self.codigo_municipio)
            if not mun:
                raise ValueError(
                    f"Código de municipio inválido ({self.codigo_municipio})."
                )
            self.codigo_municipio = mun["codigo"]
            self.municipio = mun["nombre"]
        return self


class EstructuraBackupInput(_EstructuraBase):
    @field_validator("telefono", mode="before")
    @classmethod
    def normalizar_telefono_estructura_backup(cls, v: Any) -> str:
        return normalizar_telefono_venezolano(str(v or ""), estricto=False)


class BackupRestoreInput(BaseModel):
    modo: Literal["fusionar", "reemplazar"] = Field(default="fusionar")
    activistas: List[ActivistaBackupInput] = Field(
        default_factory=list, max_length=20000
    )
    estructura: List[EstructuraBackupInput] = Field(
        default_factory=list, max_length=5000
    )

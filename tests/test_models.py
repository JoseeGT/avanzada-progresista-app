import pytest
from pydantic import ValidationError

from app.models import (
    ActivistaBackupInput,
    ActivistaInput,
    EstructuraInput,
    limpiar_cedula,
    normalizar_clave_es,
    normalizar_sexo,
)


def _base_payload(**overrides):
    data = {
        "cedula": "V-12.345.678",
        "codigo": "AP-01-01",
        "nombre_apellido": "Carlos Mendoza",
        "sexo": "H",
        "codigo_municipio": "1",
        "codigo_parroquia": "7",
        "centro_votacion": "U.E.N. LAS DELICIAS",
        "telefono": "0412-1234567",
        "correo": "carlos@example.com",
        "comunidad": "  las   delicias ",
        "enlace": " ramiro   chacón ",
    }
    data.update(overrides)
    return data


def test_limpiar_cedula_y_normalizar_clave_es():
    assert limpiar_cedula("V-12.345.678 ") == "12345678"
    assert normalizar_clave_es("  Ramiro   Chacón  Peña ") == "RAMIRO CHACON PEÑA"
    assert normalizar_clave_es("SANTIAGO MARIÑO") == "SANTIAGO MARIÑO"


def test_validar_sexo_corregido():
    assert normalizar_sexo("M", estricto=True) == "M"
    assert normalizar_sexo("Mujer", estricto=True) == "M"
    assert normalizar_sexo("Femenino", estricto=True) == "M"
    assert normalizar_sexo("H", estricto=True) == "H"
    assert normalizar_sexo("Hombre", estricto=True) == "H"
    assert normalizar_sexo("Masculino", estricto=True) == "H"
    assert normalizar_sexo("", estricto=True) == ""

    with pytest.raises(ValueError):
        normalizar_sexo("X", estricto=True)
    assert normalizar_sexo("X", estricto=False) == ""


def test_activista_input_sanitiza_y_valida_geografia():
    item = ActivistaInput(**_base_payload())
    assert item.cedula == "12345678"
    assert item.codigo_municipio == "01"
    assert item.municipio == "Girardot"
    assert item.codigo_parroquia == "07"
    assert item.parroquia == "Las Delicias"
    assert item.telefono == "04121234567"
    assert item.comunidad == "LAS DELICIAS"
    assert item.enlace == "RAMIRO CHACÓN"

    # Municipio inexistente
    with pytest.raises(ValidationError):
        ActivistaInput(**_base_payload(codigo_municipio="99"))

    # Parroquia que no pertenece a Girardot (01 tiene 01..08)
    with pytest.raises(ValidationError):
        ActivistaInput(**_base_payload(codigo_municipio="01", codigo_parroquia="15"))

    # Sexo inválido
    with pytest.raises(ValidationError):
        ActivistaInput(**_base_payload(sexo="Z"))

    # Correo inválido
    with pytest.raises(ValidationError):
        ActivistaInput(**_base_payload(correo="no-es-correo"))


def test_backup_input_es_tolerante_con_sexo_y_telefono():
    b = ActivistaBackupInput(**_base_payload(sexo="DESCONOCIDO", telefono="1234"))
    assert b.sexo == ""
    assert b.telefono == "1234"


def test_estructura_input_valida_municipio():
    est = EstructuraInput(rol="enlace", nombre="  juan perez ", codigo_municipio="2")
    assert est.codigo_municipio == "02"
    assert est.municipio == "Mario Briceño Iragorry"

    with pytest.raises(ValidationError):
        EstructuraInput(rol="enlace", nombre="Juan Perez", codigo_municipio="77")

import csv
import io
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from app import database, padron
from app.models import (
    limpiar_cedula,
    mapear_geografia_cne,
    normalizar_sexo,
    normalizar_telefono_venezolano,
    normalizar_texto,
)

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_MAX_IMPORT_ROWS = 2000


def sanitizar_celda_csv(valor: Any) -> str:
    """Protege celdas CSV contra inyección de fórmulas en Excel."""
    if valor is None:
        return ""
    s = str(valor)
    if not s:
        return ""
    stripped = s.lstrip()
    if s[0] in _FORMULA_PREFIXES or (stripped and stripped[0] in ("=", "+", "-", "@")):
        return "'" + s
    return s


def generar_csv_bytes(registros: List[Dict[str, Any]]) -> bytes:
    """Genera un archivo CSV con BOM UTF-8, delimitador ';' y protección contra fórmulas."""
    output = io.StringIO()
    output.write("\uFEFF")
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
            "Cód. Centro",
            "Centro de Votación",
            "Mesa",
            "Fecha Nacimiento",
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
            "Rol Electoral",
            "Estado Contacto",
        ]
    )
    for r in registros:
        writer.writerow(
            [
                sanitizar_celda_csv(r.get("codigo", "")),
                sanitizar_celda_csv(r.get("cedula", "")),
                sanitizar_celda_csv(r.get("nombre_apellido", "")),
                sanitizar_celda_csv(r.get("sexo", "")),
                sanitizar_celda_csv(r.get("codigo_municipio", "")),
                sanitizar_celda_csv(r.get("municipio", "")),
                sanitizar_celda_csv(r.get("codigo_parroquia", "")),
                sanitizar_celda_csv(r.get("parroquia", "")),
                sanitizar_celda_csv(r.get("cod_centro", "")),
                sanitizar_celda_csv(r.get("centro_votacion", "")),
                sanitizar_celda_csv(r.get("mesa", "")),
                sanitizar_celda_csv(r.get("fecha_nacimiento", "")),
                sanitizar_celda_csv(r.get("direccion", "")),
                sanitizar_celda_csv(r.get("telefono", "")),
                sanitizar_celda_csv(r.get("correo", "")),
                sanitizar_celda_csv(r.get("redes_sociales", "")),
                sanitizar_celda_csv(r.get("comunidad", "")),
                sanitizar_celda_csv(r.get("enlace", "")),
                sanitizar_celda_csv(r.get("responsable_municipal", "")),
                sanitizar_celda_csv(r.get("responsable_comunidad", "")),
                sanitizar_celda_csv(r.get("responsable_cal", "")),
                sanitizar_celda_csv(r.get("responsable_local", "")),
                sanitizar_celda_csv(r.get("comite_activismo_local", "")),
                sanitizar_celda_csv(r.get("direccion_cal", "")),
                sanitizar_celda_csv(r.get("rol_electoral", "")),
                sanitizar_celda_csv(r.get("estado_contacto", "")),
            ]
        )
    return output.getvalue().encode("utf-8")


def _set_cell_str(ws: Any, row: int, col: int, value: Any, as_text: bool = False) -> Any:
    s = "" if value is None else str(value)
    cell = ws.cell(row=row, column=col)
    cell.value = s
    cell.data_type = "s"
    if as_text:
        cell.number_format = "@"
    return cell


def _autoajustar_columnas(ws: Any, min_w: int = 10, max_w: int = 42, start_row: int = 4) -> None:
    for col_idx in range(1, ws.max_column + 1):
        max_len = min_w
        for row_idx in range(start_row, min(ws.max_row, start_row + 500) + 1):
            val = ws.cell(row=row_idx, column=col_idx).value
            if val is not None:
                max_len = max(max_len, len(str(val)) + 3)
        ws.column_dimensions[get_column_letter(col_idx)].width = min(max_w, max_len)


def generar_excel_bytes(
    registros: List[Dict[str, Any]],
    stats: Dict[str, Any],
    cobertura: Optional[Dict[str, Any]] = None,
    filtros_resumen: str = "",
    destinatario: str = "",
) -> bytes:
    """Genera un libro Excel (.xlsx) profesional con Directorio, Resumen Analítico y Cobertura."""
    wb = Workbook()
    header_fill = PatternFill("solid", fgColor="1E3A8A")
    sub_fill = PatternFill("solid", fgColor="EFF6FF")
    zebra_fill = PatternFill("solid", fgColor="F8FAFC")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    title_font = Font(name="Calibri", size=13, bold=True, color="0F172A")
    meta_font = Font(name="Calibri", size=10, color="334155")
    section_font = Font(name="Calibri", size=11, bold=True, color="1E3A8A")
    thin_side = Side(style="thin", color="CBD5E1")
    border = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)

    # ------------------------------------------------------------------
    # HOJA 1: DIRECTORIO DE ACTIVISTAS
    # ------------------------------------------------------------------
    ws1 = wb.active
    ws1.title = "Directorio Activistas"

    columnas = [
        ("Código", False),
        ("Cédula", True),
        ("Nombre y Apellido", False),
        ("Sexo", False),
        ("Cód. Mun.", True),
        ("Municipio", False),
        ("Cód. Par.", True),
        ("Parroquia", False),
        ("Cód. Centro", True),
        ("Centro de Votación", False),
        ("Mesa", True),
        ("Fecha Nac.", True),
        ("Teléfono", True),
        ("Correo", False),
        ("Dirección", False),
        ("Redes Sociales", False),
        ("Comunidad", False),
        ("Comité CAL", False),
        ("Dirección CAL", False),
        ("Responsable CAL", False),
        ("Enlace", False),
        ("Responsable Local", False),
        ("Responsable Comunidad", False),
        ("Responsable Municipal", False),
        ("Rol Electoral", False),
        ("Estado Contacto", False),
    ]
    campos = [
        "codigo",
        "cedula",
        "nombre_apellido",
        "sexo",
        "codigo_municipio",
        "municipio",
        "codigo_parroquia",
        "parroquia",
        "cod_centro",
        "centro_votacion",
        "mesa",
        "fecha_nacimiento",
        "telefono",
        "correo",
        "direccion",
        "redes_sociales",
        "comunidad",
        "comite_activismo_local",
        "direccion_cal",
        "responsable_cal",
        "enlace",
        "responsable_local",
        "responsable_comunidad",
        "responsable_municipal",
        "rol_electoral",
        "estado_contacto",
    ]

    ws1.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(columnas))
    c_title = _set_cell_str(
        ws1,
        1,
        1,
        "AVANZADA PROGRESISTA • CEPA — LISTADO OFICIAL DE ACTIVISTAS (ARAGUA)",
    )
    c_title.font = title_font

    fecha_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    partes_meta = [f"Fecha: {fecha_str}", f"Total: {len(registros)} registro(s)"]
    if destinatario:
        partes_meta.insert(0, f"Dirigido a: {destinatario.strip().upper()}")
    if filtros_resumen:
        partes_meta.append(f"Filtros: {filtros_resumen}")

    ws1.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(columnas))
    c_meta = _set_cell_str(ws1, 2, 1, "  |  ".join(partes_meta))
    c_meta.font = meta_font

    hdr_row = 4
    for idx, (titulo, _) in enumerate(columnas, start=1):
        cell = _set_cell_str(ws1, hdr_row, idx, titulo)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="left", vertical="center")
        cell.border = border
    ws1.row_dimensions[hdr_row].height = 24

    for r_idx, reg in enumerate(registros, start=hdr_row + 1):
        es_par = (r_idx % 2) == 0
        for c_idx, campo in enumerate(campos, start=1):
            as_text = columnas[c_idx - 1][1]
            cell = _set_cell_str(ws1, r_idx, c_idx, reg.get(campo, ""), as_text=as_text)
            cell.border = border
            cell.alignment = Alignment(vertical="center")
            if es_par:
                cell.fill = zebra_fill

    last_row = max(hdr_row, hdr_row + len(registros))
    ws1.auto_filter.ref = f"A{hdr_row}:{get_column_letter(len(columnas))}{last_row}"
    ws1.freeze_panes = f"A{hdr_row + 1}"
    _autoajustar_columnas(ws1, start_row=hdr_row)

    # ------------------------------------------------------------------
    # HOJA 2: RESUMEN ANALÍTICO (%)
    # ------------------------------------------------------------------
    ws2 = wb.create_sheet(title="Resumen Analítico")
    _set_cell_str(ws2, 1, 1, "RESUMEN ANALÍTICO ELECTORAL — ESTADO ARAGUA").font = title_font
    _set_cell_str(
        ws2,
        2,
        1,
        f"Universo analizado: {stats.get('total_registrados', 0)} activista(s)",
    ).font = meta_font

    bloques = [
        ("Por Municipio", stats.get("por_municipio", [])),
        ("Por Parroquia", stats.get("por_parroquia", [])),
        ("Por Centro de Votación", stats.get("por_centro_votacion", [])),
        ("Por Comunidad", stats.get("por_comunidad", [])),
        ("Por Responsable Municipal", stats.get("por_responsable_municipal", [])),
        ("Por Responsable CAL", stats.get("por_responsable_cal", [])),
        ("Por Sexo", stats.get("por_sexo", [])),
        ("Por Rango Etario", stats.get("por_rango_etario", [])),
        ("Por Rol Electoral", stats.get("por_rol_electoral", [])),
        ("Por Estado de Contacto", stats.get("por_estado_contacto", [])),
    ]

    cur_row = 4
    for titulo_b, items in bloques:
        ws2.merge_cells(start_row=cur_row, start_column=1, end_row=cur_row, end_column=3)
        c_sec = _set_cell_str(ws2, cur_row, 1, titulo_b)
        c_sec.font = section_font
        c_sec.fill = sub_fill
        cur_row += 1

        for col_i, h_txt in enumerate(("Categoría", "Cantidad", "Porcentaje (%)"), start=1):
            c_h = _set_cell_str(ws2, cur_row, col_i, h_txt)
            c_h.fill = header_fill
            c_h.font = header_font
            c_h.border = border
        cur_row += 1

        if not items:
            _set_cell_str(ws2, cur_row, 1, "Sin datos").border = border
            cur_row += 2
            continue

        for it in items:
            c1 = _set_cell_str(ws2, cur_row, 1, it.get("etiqueta", ""))
            c1.border = border
            c2 = ws2.cell(row=cur_row, column=2, value=int(it.get("cantidad", 0)))
            c2.border = border
            c2.number_format = "#,##0"
            c3 = ws2.cell(row=cur_row, column=3, value=float(it.get("porcentaje", 0.0)))
            c3.border = border
            c3.number_format = "0.00"
            cur_row += 1
        cur_row += 1

    ws2.column_dimensions["A"].width = 46
    ws2.column_dimensions["B"].width = 14
    ws2.column_dimensions["C"].width = 16

    # ------------------------------------------------------------------
    # HOJA 3: CENTROS SIN COBERTURA CNE
    # ------------------------------------------------------------------
    if cobertura is not None:
        ws3 = wb.create_sheet(title="Centros sin Cobertura")
        _set_cell_str(
            ws3, 1, 1, "CENTROS DE VOTACIÓN SIN COBERTURA (PADRÓN CNE ARAGUA)"
        ).font = title_font
        _set_cell_str(
            ws3,
            2,
            1,
            (
                f"Cubiertos: {cobertura.get('centros_cubiertos', 0)} / "
                f"{cobertura.get('total_centros_cne', 0)} "
                f"({cobertura.get('porcentaje_cobertura', 0)}%)  |  "
                f"Sin cobertura: {cobertura.get('centros_sin_cobertura', 0)}"
            ),
        ).font = meta_font

        hdr3 = 4
        cols3 = (
            "Cód. Centro",
            "Centro de Votación",
            "Municipio",
            "Parroquia",
            "Electores en Padrón",
        )
        for ci, ht in enumerate(cols3, start=1):
            ch = _set_cell_str(ws3, hdr3, ci, ht)
            ch.fill = header_fill
            ch.font = header_font
            ch.border = border

        sin_cob = cobertura.get("lista_sin_cobertura", [])
        for ri, c_item in enumerate(sin_cob, start=hdr3 + 1):
            _set_cell_str(ws3, ri, 1, c_item.get("cod_centro", ""), as_text=True).border = border
            _set_cell_str(ws3, ri, 2, c_item.get("centro_votacion", "")).border = border
            _set_cell_str(ws3, ri, 3, c_item.get("municipio", "")).border = border
            _set_cell_str(ws3, ri, 4, c_item.get("parroquia", "")).border = border
            ce = ws3.cell(
                row=ri, column=5, value=int(c_item.get("electores_padron") or 0)
            )
            ce.border = border
            ce.number_format = "#,##0"

        last3 = max(hdr3, hdr3 + len(sin_cob))
        ws3.auto_filter.ref = f"A{hdr3}:E{last3}"
        ws3.freeze_panes = f"A{hdr3 + 1}"
        _autoajustar_columnas(ws3, start_row=hdr3)

    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()


_HEADER_ALIASES: Dict[str, str] = {
    "CEDULA": "cedula",
    "CI": "cedula",
    "C I": "cedula",
    "NRO CEDULA": "cedula",
    "NUMERO CEDULA": "cedula",
    "NUMERO DE CEDULA": "cedula",
    "DOCUMENTO": "cedula",
    "NOMBRE": "nombre_apellido",
    "NOMBRES": "nombre_apellido",
    "NOMBRE Y APELLIDO": "nombre_apellido",
    "NOMBRES Y APELLIDOS": "nombre_apellido",
    "NOMBRE_APELLIDO": "nombre_apellido",
    "APELLIDO Y NOMBRE": "nombre_apellido",
    "ACTIVISTA": "nombre_apellido",
    "SEXO": "sexo",
    "GENERO": "sexo",
    "TELEFONO": "telefono",
    "TLF": "telefono",
    "TEL": "telefono",
    "CELULAR": "telefono",
    "MOVIL": "telefono",
    "WHATSAPP": "telefono",
    "CORREO": "correo",
    "EMAIL": "correo",
    "E MAIL": "correo",
    "CORREO ELECTRONICO": "correo",
    "DIRECCION": "direccion",
    "DIRECCION DE HABITACION": "direccion",
    "DOMICILIO": "direccion",
    "REDES": "redes_sociales",
    "REDES SOCIALES": "redes_sociales",
    "REDES_SOCIALES": "redes_sociales",
    "RED SOCIAL": "redes_sociales",
    "INSTAGRAM": "redes_sociales",
    "CODIGO": "codigo",
    "COD": "codigo",
    "COD PLANILLA": "codigo",
    "CODIGO PLANILLA": "codigo",
    "PLANILLA": "codigo",
    "MUNICIPIO": "municipio",
    "COD MUNICIPIO": "codigo_municipio",
    "CODIGO MUNICIPIO": "codigo_municipio",
    "CODIGO_MUNICIPIO": "codigo_municipio",
    "PARROQUIA": "parroquia",
    "COD PARROQUIA": "codigo_parroquia",
    "CODIGO PARROQUIA": "codigo_parroquia",
    "CODIGO_PARROQUIA": "codigo_parroquia",
    "CENTRO": "centro_votacion",
    "CENTRO DE VOTACION": "centro_votacion",
    "CENTRO VOTACION": "centro_votacion",
    "CENTRO_VOTACION": "centro_votacion",
    "COMUNIDAD": "comunidad",
    "SECTOR": "comunidad",
    "BARRIO": "comunidad",
    "URBANIZACION": "comunidad",
    "CAL": "comite_activismo_local",
    "COMITE": "comite_activismo_local",
    "COMITE CAL": "comite_activismo_local",
    "COMITE DE ACTIVISMO LOCAL": "comite_activismo_local",
    "COMITE DE ACTIVISMO LOCAL CAL": "comite_activismo_local",
    "COMITE_ACTIVISMO_LOCAL": "comite_activismo_local",
    "DIRECCION CAL": "direccion_cal",
    "DIRECCION DEL CAL": "direccion_cal",
    "DIRECCION_CAL": "direccion_cal",
    "ENLACE": "enlace",
    "RESPONSABLE MUNICIPAL": "responsable_municipal",
    "RESP MUNICIPAL": "responsable_municipal",
    "RESPONSABLE_MUNICIPAL": "responsable_municipal",
    "RESPONSABLE COMUNIDAD": "responsable_comunidad",
    "RESPONSABLE DE COMUNIDAD": "responsable_comunidad",
    "RESP COMUNIDAD": "responsable_comunidad",
    "RESPONSABLE_COMUNIDAD": "responsable_comunidad",
    "RESPONSABLE CAL": "responsable_cal",
    "RESPONSABLE DE CAL": "responsable_cal",
    "RESPONSABLE DEL CAL": "responsable_cal",
    "RESP CAL": "responsable_cal",
    "RESPONSABLE_CAL": "responsable_cal",
    "RESPONSABLE LOCAL": "responsable_local",
    "RESP LOCAL": "responsable_local",
    "RESPONSABLE_LOCAL": "responsable_local",
    "ROL ELECTORAL": "rol_electoral",
    "ROL_ELECTORAL": "rol_electoral",
    "CARGO ELECTORAL": "rol_electoral",
    "ESTADO CONTACTO": "estado_contacto",
    "ESTADO_CONTACTO": "estado_contacto",
    "VERIFICACION": "estado_contacto",
}


def _normalizar_header(raw: Any) -> str:
    txt = normalizar_texto(str(raw or ""))
    txt = re.sub(r"[^A-Z0-9]+", " ", txt).strip()
    return txt


def _leer_filas_xlsx(content: bytes) -> List[List[str]]:
    wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        ws = wb.active
        filas: List[List[str]] = []
        for idx, row in enumerate(ws.iter_rows(values_only=True)):
            if idx > _MAX_IMPORT_ROWS + 5:
                break
            str_row = ["" if v is None else str(v).strip() for v in row]
            if any(str_row):
                filas.append(str_row)
        return filas
    finally:
        wb.close()


def _leer_filas_csv(content: bytes) -> List[List[str]]:
    texto = None
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            texto = content.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if texto is None:
        raise ValueError("No se pudo decodificar el archivo CSV.")

    muestra = texto[:4096]
    delim = ";"
    if muestra.count(";") >= muestra.count(",") and muestra.count(";") >= muestra.count("\t"):
        delim = ";"
    elif muestra.count("\t") > muestra.count(","):
        delim = "\t"
    elif muestra.count(",") > 0:
        delim = ","

    reader = csv.reader(io.StringIO(texto), delimiter=delim)
    filas: List[List[str]] = []
    for idx, row in enumerate(reader):
        if idx > _MAX_IMPORT_ROWS + 5:
            break
        str_row = [str(c or "").strip() for c in row]
        if any(str_row):
            filas.append(str_row)
    return filas


def parsear_importacion(filename: str, content: bytes) -> Dict[str, Any]:
    """Lee un archivo .xlsx o .csv, cruza las cédulas contra el Padrón CNE y genera vista previa."""
    ext = (filename or "").lower().rsplit(".", 1)[-1] if "." in (filename or "") else ""
    if ext == "xlsx":
        filas_raw = _leer_filas_xlsx(content)
    elif ext in ("csv", "txt"):
        filas_raw = _leer_filas_csv(content)
    else:
        raise ValueError("Formato no soportado. Suba un archivo .xlsx o .csv.")

    if len(filas_raw) < 2:
        raise ValueError("El archivo debe incluir una fila de encabezados y al menos una fila de datos.")

    # Detectar fila de encabezados (hasta las primeras 5 filas por si hay membrete arriba)
    hdr_idx = -1
    col_map: Dict[int, str] = {}
    for idx in range(min(5, len(filas_raw))):
        cand_map: Dict[int, str] = {}
        for col_i, cell in enumerate(filas_raw[idx]):
            norm_h = _normalizar_header(cell)
            mapped = _HEADER_ALIASES.get(norm_h)
            if mapped and mapped not in cand_map.values():
                cand_map[col_i] = mapped
        if "cedula" in cand_map.values():
            hdr_idx = idx
            col_map = cand_map
            break

    if hdr_idx < 0:
        raise ValueError(
            "No se encontró la columna 'Cédula' en el archivo. Verifique los encabezados."
        )

    data_rows = filas_raw[hdr_idx + 1 :]
    if len(data_rows) > _MAX_IMPORT_ROWS:
        raise ValueError(f"El archivo supera el máximo permitido de {_MAX_IMPORT_ROWS} filas.")

    registros_crudos: List[Tuple[int, Dict[str, str]]] = []
    tiene_f_en_sexo = False
    cedulas_para_cne: List[str] = []

    for offset, row in enumerate(data_rows):
        fila_num = hdr_idx + 2 + offset
        rec: Dict[str, str] = {}
        for col_i, campo in col_map.items():
            if col_i < len(row):
                rec[campo] = row[col_i].strip()
        if not any(rec.values()):
            continue

        raw_sex = normalizar_texto(rec.get("sexo", ""))
        if raw_sex in ("F", "FEMENINO"):
            tiene_f_en_sexo = True

        ced = limpiar_cedula(rec.get("cedula", ""))
        if 5 <= len(ced) <= 12:
            cedulas_para_cne.append(ced)
        registros_crudos.append((fila_num, rec))

    cne_map = padron.buscar_electores_por_lote_sqlite(cedulas_para_cne)

    vistas_archivo = set()
    filas_preview: List[Dict[str, Any]] = []
    resumen = {
        "total_filas": len(registros_crudos),
        "listas": 0,
        "padron": 0,
        "activistas": 0,
        "ninguno": 0,
        "duplicados": 0,
        "errores": 0,
    }

    for fila_num, rec in registros_crudos:
        ced = limpiar_cedula(rec.get("cedula", ""))
        if len(ced) < 5 or len(ced) > 12:
            resumen["errores"] += 1
            filas_preview.append(
                {
                    "fila_num": fila_num,
                    "estado": "error",
                    "error": "Cédula inválida (debe tener entre 5 y 12 dígitos).",
                    "datos": {"cedula": ced, **rec},
                }
            )
            continue

        if ced in vistas_archivo:
            resumen["duplicados"] += 1
            filas_preview.append(
                {
                    "fila_num": fila_num,
                    "estado": "duplicado",
                    "error": f"Cédula {ced} repetida dentro del mismo archivo.",
                    "datos": {"cedula": ced, **rec},
                }
            )
            continue
        vistas_archivo.add(ced)

        # Normalizar sexo respetando convención detectada (M/F vs H/M)
        raw_sex = normalizar_texto(rec.get("sexo", ""))
        if tiene_f_en_sexo and raw_sex in ("M", "MASCULINO"):
            sexo_norm = "H"
        elif tiene_f_en_sexo and raw_sex in ("F", "FEMENINO"):
            sexo_norm = "M"
        else:
            sexo_norm = normalizar_sexo(raw_sex, estricto=False)

        # Normalizar teléfono tolerante en preview (reportar error si inválido)
        tel_raw = rec.get("telefono", "")
        tel_norm = ""
        tel_error = ""
        if tel_raw:
            try:
                tel_norm = normalizar_telefono_venezolano(tel_raw, estricto=True)
            except ValueError as exc:
                tel_error = str(exc)
                tel_norm = tel_raw

        cne = cne_map.get(ced)
        existente = database.obtener_activista_cache(ced)

        datos: Dict[str, Any] = {
            "cedula": ced,
            "codigo": rec.get("codigo", ""),
            "nombre_apellido": rec.get("nombre_apellido", ""),
            "sexo": sexo_norm,
            "codigo_municipio": rec.get("codigo_municipio", ""),
            "municipio": rec.get("municipio", ""),
            "codigo_parroquia": rec.get("codigo_parroquia", ""),
            "parroquia": rec.get("parroquia", ""),
            "centro_votacion": rec.get("centro_votacion", ""),
            "cod_centro": "",
            "mesa": "",
            "fecha_nacimiento": "",
            "direccion": rec.get("direccion", ""),
            "telefono": tel_norm,
            "correo": rec.get("correo", ""),
            "redes_sociales": rec.get("redes_sociales", ""),
            "comunidad": rec.get("comunidad", ""),
            "enlace": rec.get("enlace", ""),
            "responsable_municipal": rec.get("responsable_municipal", ""),
            "responsable_comunidad": rec.get("responsable_comunidad", ""),
            "responsable_cal": rec.get("responsable_cal", ""),
            "responsable_local": rec.get("responsable_local", ""),
            "comite_activismo_local": rec.get("comite_activismo_local", ""),
            "direccion_cal": rec.get("direccion_cal", ""),
            "rol_electoral": rec.get("rol_electoral", ""),
            "estado_contacto": rec.get("estado_contacto", ""),
        }

        if cne:
            datos["nombre_apellido"] = cne.get("nombre_apellido") or datos["nombre_apellido"]
            datos["codigo_municipio"] = cne.get("codigo_municipio") or datos["codigo_municipio"]
            datos["municipio"] = cne.get("municipio") or datos["municipio"]
            datos["codigo_parroquia"] = cne.get("codigo_parroquia") or datos["codigo_parroquia"]
            datos["parroquia"] = cne.get("parroquia") or datos["parroquia"]
            datos["centro_votacion"] = cne.get("centro_votacion") or datos["centro_votacion"]
            datos["cod_centro"] = cne.get("cod_centro", "")
            datos["mesa"] = cne.get("mesa", "")
            datos["fecha_nacimiento"] = cne.get("fecha_nacimiento", "")
            if not datos["sexo"] and cne.get("sexo"):
                datos["sexo"] = cne["sexo"]
        elif datos["municipio"] and not datos["codigo_municipio"]:
            cm, nm, cp, np = mapear_geografia_cne(datos["municipio"], datos["parroquia"])
            datos["codigo_municipio"] = cm
            datos["municipio"] = nm
            datos["codigo_parroquia"] = cp
            datos["parroquia"] = np

        if existente:
            for k in (
                "codigo",
                "sexo",
                "telefono",
                "correo",
                "direccion",
                "redes_sociales",
                "comunidad",
                "enlace",
                "responsable_municipal",
                "responsable_comunidad",
                "responsable_cal",
                "responsable_local",
                "comite_activismo_local",
                "direccion_cal",
                "rol_electoral",
                "estado_contacto",
            ):
                if not datos.get(k) and existente.get(k):
                    datos[k] = existente[k]

        if tel_error:
            resumen["errores"] += 1
            filas_preview.append(
                {
                    "fila_num": fila_num,
                    "estado": "error",
                    "error": tel_error,
                    "datos": datos,
                }
            )
            continue

        if len(str(datos.get("nombre_apellido") or "").strip()) < 2:
            resumen["errores"] += 1
            filas_preview.append(
                {
                    "fila_num": fila_num,
                    "estado": "error",
                    "error": "Falta Nombre y Apellido (no hallado en padrón CNE).",
                    "datos": datos,
                }
            )
            continue

        if existente:
            estado = "activistas"
            resumen["activistas"] += 1
        elif cne:
            estado = "padron"
            resumen["padron"] += 1
        else:
            estado = "ninguno"
            resumen["ninguno"] += 1

        resumen["listas"] += 1
        filas_preview.append(
            {
                "fila_num": fila_num,
                "estado": estado,
                "error": "",
                "datos": datos,
            }
        )

    return {"resumen": resumen, "filas": filas_preview}

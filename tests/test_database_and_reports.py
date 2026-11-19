import io

from openpyxl import Workbook, load_workbook

from app import config, database


def _auth_hdr(client):
    r = client.post("/api/login", json={"password": config.ADMIN_PASSWORD})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_padron_prueba_autocreacion_y_busqueda_nombre(client, isolated_env):
    hdr = _auth_hdr(client)
    assert (isolated_env / "padron_test.db").exists()

    # Consulta directa por cédula de muestra
    r_ced = client.get("/api/elector/12345678", headers=hdr)
    assert r_ced.status_code == 200
    assert r_ced.json()["encontrado_en"] == "padron"
    assert r_ced.json()["datos"]["municipio"] == "Girardot"

    # Búsqueda por nombre
    r_nom = client.get("/api/padron/buscar-nombre?q=MENDOZA", headers=hdr)
    assert r_nom.status_code == 200
    assert r_nom.json()["total"] == 1
    assert r_nom.json()["registros"][0]["cedula"] == "12345678"

    # Centros del padrón en memoria
    r_cen = client.get("/api/padron/centros", headers=hdr)
    assert r_cen.status_code == 200
    assert r_cen.json()["total"] == 5


def test_deduplicacion_sin_tildes_y_cascada_estructura(client):
    hdr = _auth_hdr(client)

    # Guardar dos activistas cuyo enlace difiere solo por tilde
    assert (
        client.post(
            "/api/activistas",
            headers=hdr,
            json={
                "cedula": "12345678",
                "codigo": "AP-01-01",
                "nombre_apellido": "CARLOS MENDOZA",
                "codigo_municipio": "01",
                "codigo_parroquia": "07",
                "enlace": "RAMIRO CHACON",
                "responsable_cal": "JOSE PEREZ",
            },
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/activistas",
            headers=hdr,
            json={
                "cedula": "15678901",
                "codigo": "AP-02-01",
                "nombre_apellido": "MARIA TORRES",
                "codigo_municipio": "02",
                "codigo_parroquia": "01",
                "enlace": "RAMIRO CHACÓN",
                "responsable_cal": "JOSÉ PEREZ",
            },
        ).status_code
        == 200
    )

    # En estructura debe haber un solo enlace y un solo responsable_cal
    est = client.get("/api/estructura", headers=hdr).json()["registros"]
    enlaces = [e for e in est if e["rol"] == "enlace"]
    resp_cals = [e for e in est if e["rol"] == "responsable_cal"]
    assert len(enlaces) == 1
    assert len(resp_cals) == 1

    # En estadísticas no se fragmenta por tilde
    stats = client.get("/api/estadisticas", headers=hdr).json()
    assert len(stats["por_responsable_cal"]) == 1
    assert stats["por_responsable_cal"][0]["cantidad"] == 2

    # Renombrar en estructura actualiza ambos activistas en cascada
    r_upd = client.post(
        "/api/estructura",
        headers=hdr,
        json={
            "id_anterior": enlaces[0]["id"],
            "rol": "enlace",
            "nombre": "RAMIRO CHACON NUEVO",
            "codigo_municipio": "01",
            "codigo_representante": "01",
        },
    )
    assert r_upd.status_code == 200
    assert r_upd.json()["activistas_actualizados"] == 2


def test_rollback_cache_ante_fallo_de_escritura(client, monkeypatch):
    hdr = _auth_hdr(client)
    assert (
        client.post(
            "/api/activistas",
            headers=hdr,
            json={
                "cedula": "12345678",
                "nombre_apellido": "CARLOS MENDOZA",
                "codigo_municipio": "01",
                "codigo_parroquia": "07",
            },
        ).status_code
        == 200
    )

    def _boom(*args, **kwargs):
        raise OSError("Disco lleno simulado")

    monkeypatch.setattr(database, "_guardar_fallback_json_locked", _boom)

    try:
        database.guardar_activista_db(
            {
                "cedula": "99999999",
                "nombre_apellido": "NO DEBE QUEDAR EN CACHE",
                "codigo_municipio": "01",
                "codigo_parroquia": "07",
            }
        )
        assert False, "Debió lanzar OSError"
    except OSError:
        pass

    # El caché debe seguir intacto sin "99999999"
    assert database.obtener_activista_cache("99999999") is None
    assert database.obtener_activista_cache("12345678") is not None


def test_csv_sanitizacion_excel_y_cobertura_y_calidad(client):
    hdr = _auth_hdr(client)
    client.post(
        "/api/activistas",
        headers=hdr,
        json={
            "cedula": "12345678",
            "codigo": "AP-01-01",
            "nombre_apellido": "CARLOS MENDOZA",
            "codigo_municipio": "01",
            "codigo_parroquia": "07",
            "centro_votacion": "U.E.N. LAS DELICIAS",
            "redes_sociales": "@carlosm",
            "direccion": "=1+1",
        },
    )

    # CSV protege contra fórmulas
    r_csv = client.get("/api/activistas/exportar-csv", headers=hdr)
    assert r_csv.status_code == 200
    txt = r_csv.content.decode("utf-8-sig")
    assert "'@carlosm" in txt
    assert "'=1+1" in txt

    # Excel .xlsx válido con 3 hojas
    r_xlsx = client.get("/api/activistas/exportar-xlsx?destinatario=CNE+Aragua", headers=hdr)
    assert r_xlsx.status_code == 200
    wb = load_workbook(io.BytesIO(r_xlsx.content))
    assert wb.sheetnames == ["Directorio Activistas", "Resumen Analítico", "Centros sin Cobertura"]
    assert wb["Directorio Activistas"].max_row == 5  # 1 fila de datos en fila 5

    # Cobertura detecta 1 cubierto de 5 muestra
    r_cob = client.get("/api/padron/cobertura", headers=hdr).json()
    assert r_cob["total_centros_cne"] == 5
    assert r_cob["centros_cubiertos"] == 1
    assert r_cob["centros_sin_cobertura"] == 4

    # Calidad de datos detecta falta de teléfono y CAL
    r_cal = client.get("/api/calidad-datos", headers=hdr).json()
    assert r_cal["resumen"]["sin_telefono"] == 1
    assert r_cal["resumen"]["sin_cal"] == 1


def test_importar_preview_bulk_y_auto_backups(client):
    hdr = _auth_hdr(client)

    # Construir un .xlsx en memoria con 2 cédulas del padrón muestra + 1 repetida
    wb = Workbook()
    ws = wb.active
    ws.append(["Cédula", "Teléfono", "Comunidad"])
    ws.append(["12345678", "04121234567", "Las Delicias"])
    ws.append(["15678901", "04149998877", "El Limón"])
    ws.append(["12345678", "04121234567", "Repetida"])
    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)

    r_prev = client.post(
        "/api/activistas/importar/preview",
        headers=hdr,
        files={
            "file": (
                "planilla.xlsx",
                bio.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert r_prev.status_code == 200
    prev = r_prev.json()
    assert prev["resumen"]["padron"] == 2
    assert prev["resumen"]["duplicados"] == 1

    # Guardar en lote y probar bulk-update + bulk-delete + auto backups
    act_list = [f["datos"] for f in prev["filas"] if f["estado"] == "padron"]
    assert client.post("/api/activistas/lote", headers=hdr, json={"activistas": act_list}).status_code == 200

    r_blk = client.post(
        "/api/activistas/bulk-update",
        headers=hdr,
        json={"cedulas": ["12345678", "15678901"], "comite_activismo_local": "CAL CENTRAL"},
    )
    assert r_blk.status_code == 200
    assert r_blk.json()["actualizados"] == 2

    # Bulk delete crea respaldo automático previo
    r_del = client.post(
        "/api/activistas/bulk-delete",
        headers=hdr,
        json={"cedulas": ["15678901"]},
    )
    assert r_del.status_code == 200
    assert r_del.json()["eliminados"] == 1

    r_bkps = client.get("/api/backups/automaticos", headers=hdr).json()
    assert r_bkps["total"] >= 1
    fname = r_bkps["registros"][0]["filename"]
    assert client.get(f"/api/backups/automaticos/{fname}", headers=hdr).status_code == 200

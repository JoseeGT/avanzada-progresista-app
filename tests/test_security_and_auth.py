import json

from app import auth, config


def test_health_y_rutas_protegidas(client):
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    assert r_health.json()["ok"] is True

    r_unauth = client.get("/api/activistas")
    assert r_unauth.status_code == 401


def test_login_cookie_httponly_csrf_y_hash_en_disco(client, isolated_env):
    resp = client.post(
        "/api/login",
        json={"password": config.ADMIN_PASSWORD},
    )
    assert resp.status_code == 200
    body = resp.json()
    token = body["token"]
    assert "ap_session" in resp.cookies

    # Verifica que el token en disco sea solo hash SHA-256 y no texto plano
    sess_file = isolated_env / ".sessions_test.json"
    assert sess_file.exists()
    raw_txt = sess_file.read_text(encoding="utf-8")
    assert token not in raw_txt
    stored = json.loads(raw_txt)
    assert len(next(iter(stored.keys()))) == 64

    # Cookie sin X-Requested-With ni Origin en POST debe ser rechazada (CSRF)
    csrf_fail = client.post(
        "/api/activistas",
        json={
            "cedula": "12345678",
            "nombre_apellido": "Test",
            "codigo_municipio": "01",
            "codigo_parroquia": "01",
        },
    )
    assert csrf_fail.status_code == 403


def test_rate_limit_y_bloqueo_login(client, monkeypatch):
    monkeypatch.setattr(config, "LOGIN_RATE_LIMIT_MAX", 20)
    # 5 fallos consecutivos activan bloqueo progresivo
    for _ in range(5):
        r = client.post("/api/login", json={"password": "mal"})
        assert r.status_code == 401

    locked = client.post("/api/login", json={"password": config.ADMIN_PASSWORD})
    assert locked.status_code == 429

    # Rate limit estricto de ventana por minuto
    with auth._RATE_LOCK:
        auth._LOGIN_FAILURES.clear()
        auth._LOGIN_RATE_BUCKETS.clear()
    monkeypatch.setattr(config, "LOGIN_RATE_LIMIT_MAX", 2)
    assert client.post("/api/login", json={"password": "mal"}).status_code == 401
    assert client.post("/api/login", json={"password": "mal"}).status_code == 401
    assert client.post("/api/login", json={"password": "mal"}).status_code == 429


def test_roles_transcriptor_y_consulta(client):
    # Login admin via Bearer
    r_login = client.post("/api/login", json={"password": config.ADMIN_PASSWORD})
    admin_hdr = {"Authorization": f"Bearer {r_login.json()['token']}"}

    # Crear transcriptor y consulta
    assert (
        client.post(
            "/api/usuarios",
            headers=admin_hdr,
            json={
                "username": "capturista1",
                "nombre": "Capturista Uno",
                "rol": "transcriptor",
                "password": "ClaveUser123!",
            },
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/usuarios",
            headers=admin_hdr,
            json={
                "username": "visor1",
                "nombre": "Visor Uno",
                "rol": "consulta",
                "password": "ClaveVisor123!",
            },
        ).status_code
        == 200
    )

    # Admin crea un activista propio
    assert (
        client.post(
            "/api/activistas",
            headers=admin_hdr,
            json={
                "cedula": "12345678",
                "nombre_apellido": "CARLOS MENDOZA",
                "codigo_municipio": "01",
                "codigo_parroquia": "07",
                "telefono": "04121234567",
            },
        ).status_code
        == 200
    )

    # Login transcriptor
    t_tok = client.post(
        "/api/login", json={"username": "capturista1", "password": "ClaveUser123!"}
    ).json()["token"]
    t_hdr = {"Authorization": f"Bearer {t_tok}"}

    # Transcriptor no ve el registro de admin ni puede exportar
    assert client.get("/api/activistas", headers=t_hdr).json()["total"] == 0
    assert client.get("/api/activistas/exportar-csv", headers=t_hdr).status_code == 403
    assert client.get("/api/activistas/exportar-xlsx", headers=t_hdr).status_code == 403
    assert client.get("/api/backup", headers=t_hdr).status_code == 403

    # Transcriptor registra uno suyo y sí lo ve
    assert (
        client.post(
            "/api/activistas",
            headers=t_hdr,
            json={
                "cedula": "15678901",
                "nombre_apellido": "MARIA TORRES",
                "codigo_municipio": "02",
                "codigo_parroquia": "01",
                "telefono": "04141112233",
            },
        ).status_code
        == 200
    )
    lista_t = client.get("/api/activistas", headers=t_hdr).json()
    assert lista_t["total"] == 1
    assert lista_t["registros"][0]["cedula"] == "15678901"

    # Login consulta: puede ver analítica, pero no escribir ni exportar
    c_tok = client.post(
        "/api/login", json={"username": "visor1", "password": "ClaveVisor123!"}
    ).json()["token"]
    c_hdr = {"Authorization": f"Bearer {c_tok}"}
    assert client.get("/api/estadisticas", headers=c_hdr).status_code == 200
    assert (
        client.post(
            "/api/activistas",
            headers=c_hdr,
            json={
                "cedula": "20112233",
                "nombre_apellido": "ANA RODRIGUEZ",
                "codigo_municipio": "07",
                "codigo_parroquia": "01",
            },
        ).status_code
        == 403
    )


def test_cedula_larga_no_genera_error_500(client):
    r_login = client.post("/api/login", json={"password": config.ADMIN_PASSWORD})
    hdr = {"Authorization": f"Bearer {r_login.json()['token']}"}
    r = client.get("/api/elector/12345678901234567890123", headers=hdr)
    assert r.status_code == 400

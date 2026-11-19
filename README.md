# Sistema de Gestión Electoral — Avanzada Progresista Aragua

Sistema web para la recepción de planillas CAL, verificación contra el Padrón Electoral CNE del Estado Aragua, administración de estructura territorial, analítica de cobertura y generación de reportes.

## Características Principales

- **Operación 100% Offline:** Tailwind CSS compilado localmente (`app/static/vendor/tailwind.css`), Chart.js y Lucide servidos desde `app/static/vendor/`, sin dependencias de CDNs externos.
- **Padrón CNE Solo Lectura:** Consulta parametrizada (`?mode=ro`) sobre `padron_cne.db` con extracción automática de centro de votación, código de centro, mesa, edad y búsqueda por nombre y apellido.
- **Caché en Memoria (Cuota Cero):** Todas las búsquedas, filtros, analítica, cobertura CNE y calidad de datos operan sobre memoria con persistencia atómica en Firestore o archivos JSON locales y rollback automático ante fallos.
- **Reportes Listos para Entregar:** Exportación a Excel multi-hoja (`.xlsx`), CSV protegido contra fórmulas, resumen rápido para WhatsApp e impresión limpia en PDF (tanto Directorio como Analítica).
- **Respaldos Automáticos Rotativos:** Copias diarias automáticas y previas a restauraciones/borrados masivos almacenadas en `backups/`.
- **Roles Ligeros Opcionales:** `admin` (control total), `transcriptor` (carga de planillas y consulta de sus propios registros, sin exportar ni respaldar) y `consulta` (solo lectura y analítica).

## Requisitos e Instalación

```powershell
# Crear y activar entorno virtual (si aún no existe)
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Instalar dependencias
.\.venv\Scripts\pip.exe install -r requirements.txt
```

## Configuración (`.env`)

Copie `.env.example` a `.env` y ajuste al menos `ADMIN_PASSWORD` y `APP_ENV`:

```ini
APP_ENV=production
ADMIN_USERNAME=admin
ADMIN_PASSWORD=una-clave-segura
PADRON_DB_PATH=padron_cne.db
```

> **Nota sobre Firestore:** Si existe `serviceAccountKey.json`, el sistema usa Firestore como respaldo en la nube; de lo contrario, opera en modo local JSON (`activistas_local.json`, `estructura_local.json`, `usuarios_local.json`).

## Ejecución del Servidor

> **Importante (`--workers 1`):** La arquitectura utiliza caché en memoria y sesiones locales dentro del proceso para garantizar Cuota Cero en Firestore. **Ejecute siempre con `--workers 1`.**

```powershell
.\.venv\Scripts\uvicorn.exe app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Luego abra `http://localhost:8000` en el navegador.

## Recompilar CSS Offline (Tailwind)

Si modifica clases Tailwind en `app/static/index.html` o `app/static/js/*.js`:

```powershell
cmd /c "npx --yes tailwindcss@3.4.17 -i ./app/static/src/input.css -o ./app/static/vendor/tailwind.css --minify"
```

## Pruebas Automatizadas

```powershell
.\.venv\Scripts\python.exe -m pytest -v
```

---
name: project-security-and-data
description: Reglas estrictas de seguridad, acceso a datos, caché en memoria y sanitización para el Sistema Web de Gestión Electoral y Activismo Político de Avanzada Progresista (Aragua).
---

# Reglas de Seguridad y Datos del Proyecto

Todo el código del backend y frontend debe cumplir estrictamente con las siguientes directrices:

1. **SQLite Solo Lectura (`padron_aragua.db`):**
   - La conexión a `padron_aragua.db` debe abrirse siempre con `uri=True` y `?mode=ro` (por ejemplo, `sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)`).
   - Todas las consultas SQL deben usar parámetros posicionales (`?`) para prevenir SQL Injection.
   - Si el archivo `padron_aragua.db` no existe al iniciar el servidor, se debe generar automáticamente una base de datos de prueba con la tabla `electores` y 5 electores de muestra de distintos municipios/parroquias de Aragua antes de abrirla en modo solo lectura.

2. **Caché en Memoria para Firestore (Cuota Cero):**
   - Mantener en memoria en Python un caché de la colección `activistas` de Firestore (cargado al iniciar la aplicación).
   - Todos los listados, los 8 filtros combinables y el cálculo de estadísticas (`%`) deben ejecutarse exclusivamente sobre ese caché en memoria para no consumir lecturas gratuitas de Firebase.
   - Actualizar el caché únicamente al ejecutar operaciones de escritura (`POST`, `PUT` o `DELETE`), manteniendo sincronizado el caché con Firestore (o con `activistas_local.json` cuando esté activo el modo Fallback local).

3. **Seguridad y Rate Limiting:**
   - Proteger todos los endpoints `/api/*` (excepto `/api/login` y `/api/health` si existiera) verificando la sesión/token mediante `Depends()` en FastAPI y comparación en tiempo constante con `secrets.compare_digest`.
   - Incluir un Rate Limiter nativo en memoria (máximo 30 consultas por minuto por IP).

4. **Sanitización Venezolana (Pydantic):**
   - Limpiar el campo `cedula` dejando únicamente dígitos numéricos.
   - Convertir automáticamente a MAYÚSCULAS SIN ESPACIOS EXTRA (`.strip().upper()`, colapsando espacios internos múltiples si aplica) los campos manuales: `comunidad`, `enlace`, `responsable_municipal`, `responsable_cal`, `responsable_local`, `comite_activismo_local`, para evitar duplicados en estadísticas por errores de escritura.

5. **Seguridad Git (`.gitignore`):**
   - Excluir `.env`, `*.db`, `serviceAccountKey.json`, `activistas_local.json`, `__pycache__/` y entornos virtuales (`.venv/`, `venv/`).

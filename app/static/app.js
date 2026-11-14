(() => {
  'use strict';

  const STATE = {
    token: sessionStorage.getItem('ap_token') || '',
    catalogo: [],
    modoEdicion: false,
    ultimoListado: [],
    todosActivistas: [],
    vistaDirectorio: 'tabla', // 'tabla' | 'cards'
    charts: {
      municipio: null,
      parroquiaComunidad: null,
      centro: null,
      responsables: null,
    },
  };

  const $ = (id) => document.getElementById(id);

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizarWhatsApp(telefono) {
    const digits = String(telefono || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('58')) return digits;
    if (digits.startsWith('0')) return '58' + digits.slice(1);
    return '58' + digits;
  }

  function obtenerIniciales(nombre) {
    const parts = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'AP';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function mostrarToast(mensaje, tipo = 'info') {
    const box = $('toast-box');
    const estilos = {
      ok: 'bg-emerald-50 border-emerald-200 text-emerald-800',
      error: 'bg-red-50 border-red-200 text-red-800',
      info: 'bg-blue-50 border-blue-200 text-blue-800',
    };
    box.className = `no-print fixed bottom-5 right-5 z-50 max-w-sm px-4 py-3 rounded-xl shadow-md border text-sm font-medium ${estilos[tipo] || estilos.info}`;
    box.textContent = mensaje;
    box.classList.remove('hidden');
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.classList.add('hidden'), 3800);
  }

  async function apiFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (STATE.token) {
      headers['Authorization'] = `Bearer ${STATE.token}`;
    }
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (res.status === 401) {
      cerrarSesionLocal();
      throw new Error('Sesión expirada. Ingrese nuevamente.');
    }
    if (!res.ok) {
      let detail = `Error ${res.status}`;
      try {
        const err = await res.json();
        if (err && err.detail) {
          detail = Array.isArray(err.detail)
            ? err.detail.map((d) => d.msg || JSON.stringify(d)).join(', ')
            : err.detail;
        }
      } catch (_) {}
      throw new Error(detail);
    }
    return res;
  }

  // =========================================================
  // 1. AUTENTICACIÓN
  // =========================================================
  $('toggle-password-btn').addEventListener('click', () => {
    const input = $('login-password');
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    $('eye-icon').setAttribute('data-lucide', isPass ? 'eye-off' : 'eye');
    refreshIcons();
  });

  function mostrarApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    refreshIcons();
  }

  function cerrarSesionLocal() {
    STATE.token = '';
    sessionStorage.removeItem('ap_token');
    $('app-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
    $('login-password').value = '';
    refreshIcons();
  }

  async function inicializarSesion() {
    mostrarApp();
    await Promise.all([cargarCatalogo(), cargarEstadoSistema(), refrescarKPIs()]);
    await actualizarCodigoSiguiente($('form-municipio').value || '01');
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('login-error');
    errBox.classList.add('hidden');
    const password = $('login-password').value;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || 'Clave de acceso incorrecta.');
      }
      const data = await res.json();
      STATE.token = data.token;
      sessionStorage.setItem('ap_token', STATE.token);
      await inicializarSesion();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });

  async function handleLogout() {
    try {
      await apiFetch('/api/logout', { method: 'POST' });
    } catch (_) {}
    cerrarSesionLocal();
  }
  $('btn-logout-sidebar').addEventListener('click', handleLogout);
  $('btn-logout-topbar').addEventListener('click', handleLogout);

  // =========================================================
  // 2. SIDEBAR CLARA, TOPBAR & 4 KPIs SUPERIORES
  // =========================================================
  function toggleSidebarMobile(open) {
    const sb = $('sidebar');
    const bd = $('sidebar-backdrop');
    if (open) {
      sb.classList.remove('-translate-x-full');
      bd.classList.remove('hidden');
    } else {
      sb.classList.add('-translate-x-full');
      bd.classList.add('hidden');
    }
  }
  $('btn-open-sidebar').addEventListener('click', () => toggleSidebarMobile(true));
  $('btn-close-sidebar').addEventListener('click', () => toggleSidebarMobile(false));
  $('sidebar-backdrop').addEventListener('click', () => toggleSidebarMobile(false));

  async function cargarEstadoSistema() {
    try {
      const res = await apiFetch('/api/estado-sistema');
      const data = await res.json();
      $('sidebar-db-status').textContent =
        data.modo_persistencia === 'firestore' ? 'Firestore' : 'JSON Local';
      $('sidebar-cne-status').textContent = data.padron_disponible ? 'Online' : 'Inactivo';
    } catch (_) {}
  }

  async function refrescarKPIs() {
    try {
      const res = await apiFetch('/api/activistas');
      const data = await res.json();
      const regs = data.registros || [];
      STATE.todosActivistas = regs;

      const total = regs.length;
      const municipiosSet = new Set(regs.map((r) => r.codigo_municipio).filter(Boolean));
      const calsSet = new Set(
        regs.map((r) => String(r.comite_activismo_local || '').trim()).filter(Boolean)
      );
      const centrosSet = new Set(
        regs.map((r) => String(r.centro_votacion || '').trim()).filter(Boolean)
      );

      const munCount = municipiosSet.size;
      const munPct = Math.round((munCount / 18) * 100);

      $('kpi-total-activistas').textContent = total;
      $('kpi-municipios-activos').textContent = munCount;
      $('kpi-municipios-pct').textContent = `${munPct}%`;
      $('kpi-municipios-bar').style.width = `${munPct}%`;
      $('kpi-cals-activos').textContent = calsSet.size;
      $('kpi-centros-cubiertos').textContent = centrosSet.size;
      renderizarChipsMunicipios();
    } catch (_) {}
  }

  const VIEW_TITLES = {
    registro: 'Recepción y Registro',
    listados: 'Directorio de Activistas',
    estadisticas: 'Reportes y Analítica (%)',
  };

  function activarTab(tabName) {
    ['registro', 'listados', 'estadisticas'].forEach((t) => {
      const sec = $(`tab-${t}`);
      if (t === tabName) sec.classList.remove('hidden');
      else sec.classList.add('hidden');
    });

    document.querySelectorAll('.nav-item').forEach((btn) => {
      const icon = btn.querySelector('.nav-icon');
      if (btn.dataset.tab === tabName) {
        btn.classList.add('bg-blue-600/15', 'text-white', 'border-blue-500/30', 'font-semibold');
        btn.classList.remove('text-slate-400', 'hover:bg-slate-800/70', 'hover:text-white', 'border-transparent', 'font-medium');
        if (icon) icon.classList.add('text-blue-400');
      } else {
        btn.classList.remove('bg-blue-600/15', 'text-white', 'border-blue-500/30', 'font-semibold');
        btn.classList.add('text-slate-400', 'hover:bg-slate-800/70', 'hover:text-white', 'border-transparent', 'font-medium');
        if (icon) icon.classList.remove('text-blue-400');
      }
    });

    $('topbar-view-title').textContent = VIEW_TITLES[tabName] || 'Panel Electoral';
    toggleSidebarMobile(false);

    if (tabName === 'listados') {
      cargarListado();
    } else if (tabName === 'estadisticas') {
      renderizarAnalitica();
    }
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => activarTab(btn.dataset.tab));
  });

  $('btn-nuevo-registro-sidebar').addEventListener('click', () => {
    $('cne-cedula-search').value = '';
    limpiarFormulario();
    activarTab('registro');
    $('cne-cedula-search').focus();
  });

  $('topbar-quick-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = $('topbar-quick-search').value.replace(/\D/g, '');
      if (q.length >= 5) {
        $('cne-cedula-search').value = q;
        activarTab('registro');
        buscarCedulaCNE();
      } else {
        mostrarToast('Ingrese al menos 5 dígitos de cédula.', 'error');
      }
    }
  });

  // =========================================================
  // CATÁLOGO GEOGRÁFICO (01-18) Y SELECTORES ENCADENADOS
  // =========================================================
  async function cargarCatalogo() {
    const res = await apiFetch('/api/catalogo-geografico');
    STATE.catalogo = await res.json();

    const selectsMun = [
      { el: $('form-municipio'), placeholder: 'Seleccione municipio...' },
      { el: $('flt-municipio'), placeholder: 'Todos los Municipios' },
      { el: $('drw-municipio'), placeholder: 'Seleccione municipio...' },
      { el: $('stats-flt-municipio'), placeholder: 'Todos los Municipios (Aragua)' },
    ];

    for (const cfg of selectsMun) {
      cfg.el.innerHTML = `<option value="">${escapeHtml(cfg.placeholder)}</option>`;
      for (const m of STATE.catalogo) {
        cfg.el.insertAdjacentHTML(
          'beforeend',
          `<option value="${escapeHtml(m.codigo)}">${escapeHtml(m.codigo)} - ${escapeHtml(m.nombre)}</option>`
        );
      }
    }

    poblarParroquiasSelect($('flt-parroquia'), '', '', 'Todas las Parroquias', true);
    poblarParroquiasSelect($('stats-flt-parroquia'), '', '', 'Todas las Parroquias', false);
    renderizarChipsMunicipios();
  }

  function poblarParroquiasSelect(
    selectEl,
    codMun,
    selectedCodPar = '',
    placeholder = 'Seleccione parroquia...',
    incluirTodasSiVacio = false
  ) {
    selectEl.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`;
    if (codMun) {
      const mun = STATE.catalogo.find((m) => m.codigo === codMun);
      if (mun) {
        for (const p of mun.parroquias) {
          selectEl.insertAdjacentHTML(
            'beforeend',
            `<option value="${escapeHtml(p.codigo)}">${escapeHtml(p.codigo)} - ${escapeHtml(p.nombre)}</option>`
          );
        }
      }
    } else if (incluirTodasSiVacio) {
      for (const mun of STATE.catalogo) {
        for (const p of mun.parroquias) {
          selectEl.insertAdjacentHTML(
            'beforeend',
            `<option value="${escapeHtml(p.codigo)}" data-mun="${escapeHtml(mun.codigo)}">${escapeHtml(p.nombre)} (${escapeHtml(mun.nombre)})</option>`
          );
        }
      }
    }
    if (selectedCodPar) {
      selectEl.value = selectedCodPar;
    }
  }

  async function actualizarCodigoSiguiente(codMun) {
    if (STATE.modoEdicion || !codMun) return;
    try {
      const res = await apiFetch(`/api/activistas/codigo-siguiente/${encodeURIComponent(codMun)}`);
      const data = await res.json();
      $('form-codigo').value = data.codigo;
    } catch (_) {}
  }

  $('form-municipio').addEventListener('change', async (e) => {
    const codMun = e.target.value;
    poblarParroquiasSelect($('form-parroquia'), codMun);
    await actualizarCodigoSiguiente(codMun || '01');
  });

  $('flt-municipio').addEventListener('change', (e) => {
    poblarParroquiasSelect($('flt-parroquia'), e.target.value, '', 'Todas las Parroquias', true);
    renderizarChipsMunicipios();
  });

  $('flt-parroquia').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.dataset && opt.dataset.mun && !$('flt-municipio').value) {
      const codMun = opt.dataset.mun;
      const codPar = opt.value;
      $('flt-municipio').value = codMun;
      poblarParroquiasSelect($('flt-parroquia'), codMun, codPar, 'Todas las Parroquias', true);
      renderizarChipsMunicipios();
    }
  });

  $('drw-municipio').addEventListener('change', (e) => {
    poblarParroquiasSelect($('drw-parroquia'), e.target.value);
  });

  // =========================================================
  // 3. VISTA 1: RECEPCIÓN Y REGISTRO
  // =========================================================
  function setSexoUI(val) {
    const norm = String(val || '').toUpperCase();
    $('form-sexo').value = norm;
    document.querySelectorAll('.sexo-toggle').forEach((btn) => {
      if (btn.dataset.sexo === norm) {
        btn.classList.add('bg-[#2563EB]', 'text-white', 'border-[#2563EB]');
        btn.classList.remove('bg-[#F8FAFC]', 'text-slate-600', 'border-slate-300');
      } else {
        btn.classList.remove('bg-[#2563EB]', 'text-white', 'border-[#2563EB]');
        btn.classList.add('bg-[#F8FAFC]', 'text-slate-600', 'border-slate-300');
      }
    });
  }

  document.querySelectorAll('.sexo-toggle').forEach((btn) => {
    btn.addEventListener('click', () => setSexoUI(btn.dataset.sexo));
  });

  function actualizarBotonWhatsAppForm() {
    const wa = normalizarWhatsApp($('form-telefono').value);
    const btn = $('form-whatsapp-btn');
    if (wa.length >= 10) {
      btn.href = `https://wa.me/${wa}`;
      btn.classList.remove('hidden');
      btn.classList.add('inline-flex');
    } else {
      btn.classList.add('hidden');
      btn.classList.remove('inline-flex');
    }
  }
  $('form-telefono').addEventListener('input', actualizarBotonWhatsAppForm);

  function actualizarTarjetaResumen(datos, estado) {
    const card = $('elector-summary-card');
    card.classList.remove('hidden');

    const nombre = datos.nombre_apellido || 'Sin nombre registrado';
    $('summary-avatar').textContent = obtenerIniciales(nombre);
    $('summary-nombre').textContent = nombre;
    $('summary-cedula').textContent = `C.I. ${datos.nacionalidad || $('cne-nacionalidad').value}-${datos.cedula || ''}`;
    $('summary-codigo').textContent = datos.codigo || $('form-codigo').value || 'AP-01-0001';
    $('summary-municipio').textContent = datos.municipio || '-';
    $('summary-parroquia').textContent = datos.parroquia || '-';
    $('summary-centro').textContent = datos.centro_votacion || 'Sin centro asignado';

    const badge = $('summary-badge');
    if (estado === 'activistas') {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200';
      badge.textContent = 'Activista Ya Registrado - Modo Edición';
    } else if (estado === 'padron') {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200';
      badge.textContent = 'Padrón CNE Verificado';
    } else {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white text-slate-600 border border-slate-200';
      badge.textContent = 'Registro Manual (No hallado en Padrón)';
    }
  }

  function limpiarFormulario() {
    STATE.modoEdicion = false;
    $('activista-form').reset();
    $('form-parroquia').innerHTML = '<option value="">Seleccione parroquia...</option>';
    setSexoUI('');
    $('btn-guardar-text').textContent = 'Guardar Activista';
    $('btn-eliminar-activista').classList.add('hidden');
    $('elector-summary-card').classList.add('hidden');
    actualizarBotonWhatsAppForm();
    actualizarCodigoSiguiente('01');
  }

  function cargarDatosEnFormulario(d, modoEdicion) {
    STATE.modoEdicion = modoEdicion;
    $('form-codigo').value = d.codigo || '';
    $('form-cedula').value = d.cedula || '';
    $('form-nombre').value = d.nombre_apellido || '';
    setSexoUI(d.sexo || '');

    const codMun = d.codigo_municipio ? String(d.codigo_municipio).padStart(2, '0') : '';
    const codPar = d.codigo_parroquia ? String(d.codigo_parroquia).padStart(2, '0') : '';
    $('form-municipio').value = codMun;
    poblarParroquiasSelect($('form-parroquia'), codMun, codPar);

    $('form-centro').value = d.centro_votacion || '';
    $('form-comunidad').value = d.comunidad || '';
    $('form-telefono').value = d.telefono || '';
    $('form-correo').value = d.correo || '';
    $('form-redes').value = d.redes_sociales || '';
    $('form-cal').value = d.comite_activismo_local || '';
    $('form-resp-cal').value = d.responsable_cal || '';
    $('form-resp-local').value = d.responsable_local || '';
    $('form-resp-municipal').value = d.responsable_municipal || '';
    $('form-enlace').value = d.enlace || '';

    actualizarBotonWhatsAppForm();

    if (modoEdicion) {
      $('btn-guardar-text').textContent = 'Actualizar Activista';
      $('btn-eliminar-activista').classList.remove('hidden');
    } else {
      $('btn-guardar-text').textContent = 'Guardar Activista';
      $('btn-eliminar-activista').classList.add('hidden');
    }
  }

  async function buscarCedulaCNE() {
    const raw = $('cne-cedula-search').value.replace(/\D/g, '');
    if (raw.length < 5) {
      mostrarToast('Ingrese una cédula válida (mínimo 5 dígitos).', 'error');
      return;
    }
    $('cne-cedula-search').value = raw;

    try {
      const res = await apiFetch(`/api/elector/${encodeURIComponent(raw)}`);
      const data = await res.json();

      if (data.datos && data.datos.nacionalidad) {
        $('cne-nacionalidad').value = data.datos.nacionalidad;
      }

      if (data.encontrado_en === 'activistas') {
        cargarDatosEnFormulario(data.datos, true);
        mostrarToast('Activista ya registrado — Modo Edición.', 'info');
      } else if (data.encontrado_en === 'padron') {
        cargarDatosEnFormulario(data.datos, false);
        mostrarToast('Elector verificado en Padrón CNE Aragua.', 'ok');
      } else {
        cargarDatosEnFormulario(data.datos, false);
        mostrarToast('Cédula no hallada en padrón — Registro manual.', 'info');
      }
      actualizarTarjetaResumen(data.datos, data.encontrado_en);
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  }

  $('btn-buscar-cne').addEventListener('click', buscarCedulaCNE);
  $('cne-cedula-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      buscarCedulaCNE();
    }
  });

  $('btn-limpiar-form').addEventListener('click', () => {
    $('cne-cedula-search').value = '';
    limpiarFormulario();
  });

  $('activista-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      cedula: $('form-cedula').value,
      codigo: STATE.modoEdicion ? $('form-codigo').value : '',
      nombre_apellido: $('form-nombre').value,
      sexo: $('form-sexo').value,
      codigo_municipio: $('form-municipio').value,
      codigo_parroquia: $('form-parroquia').value,
      centro_votacion: $('form-centro').value,
      telefono: $('form-telefono').value,
      correo: $('form-correo').value,
      redes_sociales: $('form-redes').value,
      comunidad: $('form-comunidad').value,
      enlace: $('form-enlace').value,
      responsable_municipal: $('form-resp-municipal').value,
      responsable_cal: $('form-resp-cal').value,
      responsable_local: $('form-resp-local').value,
      comite_activismo_local: $('form-cal').value,
    };

    try {
      const res = await apiFetch('/api/activistas', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      mostrarToast(`Activista ${data.activista.nombre_apellido} (${data.activista.codigo}) guardado.`, 'ok');
      cargarDatosEnFormulario(data.activista, true);
      actualizarTarjetaResumen(data.activista, 'activistas');
      await refrescarKPIs();
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  });

  $('btn-eliminar-activista').addEventListener('click', async () => {
    const cedula = $('form-cedula').value.replace(/\D/g, '');
    if (!cedula) return;
    if (!confirm(`¿Confirma eliminar al activista con cédula ${cedula}?`)) return;

    try {
      await apiFetch(`/api/activistas/${encodeURIComponent(cedula)}`, { method: 'DELETE' });
      mostrarToast(`Activista ${cedula} eliminado.`, 'ok');
      $('cne-cedula-search').value = '';
      limpiarFormulario();
      await refrescarKPIs();
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  });

  // =========================================================
  // 4. VISTA 2: DIRECTORIO DE ACTIVISTAS
  // =========================================================
  function renderizarChipsMunicipios() {
    const bar = $('municipios-chips-bar');
    if (!bar || !STATE.catalogo.length) return;

    const actual = $('flt-municipio').value;
    const conteos = new Map();
    for (const r of STATE.todosActivistas) {
      const cm = String(r.codigo_municipio || '').padStart(2, '0');
      conteos.set(cm, (conteos.get(cm) || 0) + 1);
    }

    const activos = STATE.catalogo.filter((m) => (conteos.get(m.codigo) || 0) > 0);
    const listaMostrar = activos.length ? activos : STATE.catalogo;

    let html = `
      <button
        type="button"
        data-chip-mun=""
        class="mun-chip cursor-pointer px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
          actual === ''
            ? 'bg-[#2563EB] text-white shadow-sm'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
        }"
      >
        Todos (${STATE.todosActivistas.length})
      </button>`;

    for (const m of listaMostrar) {
      const cnt = conteos.get(m.codigo) || 0;
      const isActive = actual === m.codigo;
      html += `
        <button
          type="button"
          data-chip-mun="${escapeHtml(m.codigo)}"
          class="mun-chip cursor-pointer px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
            isActive
              ? 'bg-[#2563EB] text-white shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-[#2563EB]'
          }"
        >
          ${escapeHtml(m.codigo)} · ${escapeHtml(m.nombre)} (${cnt})
        </button>`;
    }

    bar.innerHTML = html;
    bar.querySelectorAll('.mun-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cm = btn.dataset.chipMun;
        $('flt-municipio').value = cm;
        poblarParroquiasSelect($('flt-parroquia'), cm, '', 'Todas las Parroquias', true);
        renderizarChipsMunicipios();
        cargarListado();
      });
    });
  }

  function obtenerQueryFiltros() {
    const params = new URLSearchParams();
    const mapa = {
      cedula: $('flt-cedula').value.trim(),
      codigo: $('flt-codigo').value.trim(),
      codigo_municipio: $('flt-municipio').value,
      codigo_parroquia: $('flt-parroquia').value,
      centro_votacion: $('flt-centro').value.trim(),
      comunidad: $('flt-comunidad').value.trim(),
      enlace: $('flt-enlace').value.trim(),
      responsable_cal: $('flt-resp-cal').value.trim(),
      responsable_local: $('flt-resp-local').value.trim(),
    };
    for (const [k, v] of Object.entries(mapa)) {
      if (v) params.set(k, v);
    }
    return params;
  }

  async function cargarListado() {
    const params = obtenerQueryFiltros();
    const qs = params.toString();
    const url = qs ? `/api/activistas?${qs}` : '/api/activistas';

    try {
      const res = await apiFetch(url);
      const data = await res.json();
      STATE.ultimoListado = data.registros || [];
      $('listado-conteo').textContent = `${data.total} resultado(s)`;
      renderizarDirectorio();
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  }

  function setVistaDirectorio(modo) {
    STATE.vistaDirectorio = modo;
    if (modo === 'tabla') {
      $('contenedor-vista-tabla').classList.remove('hidden');
      $('contenedor-vista-cards').classList.add('hidden');
      $('view-mode-tabla').classList.add('bg-white', 'text-[#2563EB]', 'shadow-sm');
      $('view-mode-tabla').classList.remove('text-slate-600');
      $('view-mode-cards').classList.remove('bg-white', 'text-[#2563EB]', 'shadow-sm');
      $('view-mode-cards').classList.add('text-slate-600');
    } else {
      $('contenedor-vista-tabla').classList.add('hidden');
      $('contenedor-vista-cards').classList.remove('hidden');
      $('view-mode-cards').classList.add('bg-white', 'text-[#2563EB]', 'shadow-sm');
      $('view-mode-cards').classList.remove('text-slate-600');
      $('view-mode-tabla').classList.remove('bg-white', 'text-[#2563EB]', 'shadow-sm');
      $('view-mode-tabla').classList.add('text-slate-600');
    }
    renderizarDirectorio();
  }

  $('view-mode-tabla').addEventListener('click', () => setVistaDirectorio('tabla'));
  $('view-mode-cards').addEventListener('click', () => setVistaDirectorio('cards'));

  function renderizarDirectorio() {
    const regs = STATE.ultimoListado;
    const tbody = $('tabla-activistas-body');
    const cardsBox = $('contenedor-vista-cards');

    if (!regs.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-10 text-center text-slate-500">No se encontraron activistas con los criterios aplicados.</td></tr>`;
      cardsBox.innerHTML = `<div class="col-span-full bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">No se encontraron activistas con los criterios aplicados.</div>`;
      return;
    }

    tbody.innerHTML = regs
      .map((r) => {
        const wa = normalizarWhatsApp(r.telefono);
        const telHtml = r.telefono
          ? `<div class="flex items-center gap-1.5 font-mono text-slate-700 whitespace-nowrap">
               <span>${escapeHtml(r.telefono)}</span>
               ${wa.length >= 10 ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer" class="no-print text-emerald-600 hover:text-emerald-700"><i data-lucide="message-circle" class="w-3.5 h-3.5"></i></a>` : ''}
             </div>`
          : '<span class="text-slate-400">-</span>';

        return `
          <tr class="hover:bg-blue-50/30 transition-colors">
            <td class="px-3 py-3 font-mono font-semibold text-[#2563EB] whitespace-nowrap">${escapeHtml(r.codigo)}</td>
            <td class="px-3 py-3 font-mono text-slate-700 whitespace-nowrap">${escapeHtml(r.cedula)}</td>
            <td class="px-3 py-3 font-semibold text-slate-800 max-w-[200px] whitespace-normal leading-tight">${escapeHtml(r.nombre_apellido)}</td>
            <td class="px-3 py-3">${telHtml}</td>
            <td class="px-3 py-3 max-w-[170px] whitespace-normal leading-tight">
              <div class="font-medium text-slate-800">${escapeHtml(r.municipio)}</div>
              <div class="text-[11px] text-slate-500">${escapeHtml(r.parroquia)}</div>
            </td>
            <td class="px-3 py-3 text-slate-600 max-w-[200px] whitespace-normal leading-tight">${escapeHtml(r.centro_votacion || '-')}</td>
            <td class="px-3 py-3 max-w-[180px] whitespace-normal leading-tight">
              <div class="font-medium text-slate-800">${escapeHtml(r.comite_activismo_local || '-')}</div>
              <div class="text-[11px] text-slate-500">${escapeHtml(r.responsable_cal || r.enlace || '')}</div>
            </td>
            <td class="no-print px-3 py-3 text-right whitespace-nowrap">
              <div class="inline-flex items-center gap-1">
                <button type="button" data-action="ver" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors">
                  Expediente
                </button>
                <button type="button" data-action="editar" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-xs font-semibold text-[#2563EB] bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors">
                  Editar
                </button>
                <button type="button" data-action="eliminar" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors">
                  Eliminar
                </button>
              </div>
            </td>
          </tr>`;
      })
      .join('');

    cardsBox.innerHTML = regs
      .map((r) => {
        const wa = normalizarWhatsApp(r.telefono);
        return `
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col justify-between space-y-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <span class="inline-block px-2 py-0.5 rounded-lg bg-blue-50 text-[#2563EB] font-mono text-[11px] font-bold">${escapeHtml(r.codigo)}</span>
                <h4 class="text-sm font-bold text-slate-800 mt-1.5 truncate">${escapeHtml(r.nombre_apellido)}</h4>
                <p class="text-xs font-mono text-slate-500">C.I. ${escapeHtml(r.cedula)}</p>
              </div>
              ${wa.length >= 10 ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer" class="p-2 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-100"><i data-lucide="message-circle" class="w-4 h-4"></i></a>` : ''}
            </div>
            <div class="text-xs space-y-1 border-t border-slate-100 pt-2.5 text-slate-600">
              <p><span class="font-semibold text-slate-700">Territorio:</span> ${escapeHtml(r.municipio)} / ${escapeHtml(r.parroquia)}</p>
              <p class="truncate"><span class="font-semibold text-slate-700">Centro:</span> ${escapeHtml(r.centro_votacion || '-')}</p>
              <p><span class="font-semibold text-slate-700">CAL:</span> ${escapeHtml(r.comite_activismo_local || '-')}</p>
            </div>
            <div class="flex items-center justify-end gap-1.5 pt-2 border-t border-slate-100">
              <button type="button" data-action="ver" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg">Expediente</button>
              <button type="button" data-action="editar" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-[11px] font-semibold text-[#2563EB] bg-blue-50 hover:bg-blue-100 rounded-lg">Editar</button>
            </div>
          </div>`;
      })
      .join('');

    refreshIcons();

    document.querySelectorAll('.row-action-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ced = btn.dataset.cedula;
        const action = btn.dataset.action;
        const reg = STATE.ultimoListado.find((x) => x.cedula === ced);
        if (!reg) return;

        if (action === 'ver') {
          abrirDrawer(reg, false);
        } else if (action === 'editar') {
          abrirDrawer(reg, true);
        } else if (action === 'eliminar') {
          if (!confirm(`¿Seguro que desea eliminar a ${reg.nombre_apellido} (${ced})?`)) return;
          try {
            await apiFetch(`/api/activistas/${encodeURIComponent(ced)}`, { method: 'DELETE' });
            mostrarToast(`Activista ${ced} eliminado.`, 'ok');
            await Promise.all([cargarListado(), refrescarKPIs()]);
          } catch (err) {
            mostrarToast(err.message, 'error');
          }
        }
      });
    });
  }

  $('btn-aplicar-filtros').addEventListener('click', cargarListado);
  $('btn-limpiar-filtros').addEventListener('click', () => {
    $('flt-cedula').value = '';
    $('flt-codigo').value = '';
    $('flt-municipio').value = '';
    poblarParroquiasSelect($('flt-parroquia'), '', '', 'Todas las Parroquias', true);
    $('flt-centro').value = '';
    $('flt-comunidad').value = '';
    $('flt-enlace').value = '';
    $('flt-resp-cal').value = '';
    $('flt-resp-local').value = '';
    renderizarChipsMunicipios();
    cargarListado();
  });

  let cedulaDebounce = null;
  $('flt-cedula').addEventListener('input', () => {
    clearTimeout(cedulaDebounce);
    cedulaDebounce = setTimeout(cargarListado, 250);
  });

  // =========================================================
  // SLIDE-OVER DRAWER LATERAL DERECHO
  // =========================================================
  function toggleDrawerModo(edicion) {
    if (edicion) {
      $('drawer-title').textContent = 'Editar Datos de Activista';
      $('drawer-view-mode').classList.add('hidden');
      $('drawer-edit-form').classList.remove('hidden');
      $('btn-drawer-switch-edit').classList.add('hidden');
      $('btn-drawer-save').classList.remove('hidden');
    } else {
      $('drawer-title').textContent = 'Expediente de Activista';
      $('drawer-view-mode').classList.remove('hidden');
      $('drawer-edit-form').classList.add('hidden');
      $('btn-drawer-switch-edit').classList.remove('hidden');
      $('btn-drawer-save').classList.add('hidden');
    }
  }

  function abrirDrawer(r, iniciarEnEdicion = false) {
    $('drawer-subtitle').textContent = `${r.codigo} • C.I. ${r.cedula}`;

    const campos = [
      ['Nombre y Apellido', r.nombre_apellido],
      ['Sexo', r.sexo || '-'],
      ['Teléfono', r.telefono || '-'],
      ['Correo', r.correo || '-'],
      ['Redes Sociales', r.redes_sociales || '-'],
      ['Municipio', `${r.codigo_municipio} - ${r.municipio}`],
      ['Parroquia', `${r.codigo_parroquia} - ${r.parroquia}`],
      ['Centro de Votación', r.centro_votacion || '-'],
      ['Comunidad / Sector', r.comunidad || '-'],
      ['Comité Activismo Local (CAL)', r.comite_activismo_local || '-'],
      ['Responsable de CAL', r.responsable_cal || '-'],
      ['Responsable Local', r.responsable_local || '-'],
      ['Responsable Municipal', r.responsable_municipal || '-'],
      ['Enlace', r.enlace || '-'],
    ];
    $('drawer-view-mode').innerHTML = campos
      .map(
        ([lbl, val]) => `
        <div class="bg-[#F8FAFC] border border-slate-200/80 rounded-xl p-3">
          <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(lbl)}</p>
          <p class="text-xs font-semibold text-slate-800 mt-0.5 break-words">${escapeHtml(val)}</p>
        </div>`
      )
      .join('');

    $('drw-cedula').value = r.cedula;
    $('drw-codigo').value = r.codigo;
    $('drw-nombre').value = r.nombre_apellido || '';
    $('drw-sexo').value = r.sexo || '';
    $('drw-telefono').value = r.telefono || '';
    const codMun = r.codigo_municipio ? String(r.codigo_municipio).padStart(2, '0') : '';
    const codPar = r.codigo_parroquia ? String(r.codigo_parroquia).padStart(2, '0') : '';
    $('drw-municipio').value = codMun;
    poblarParroquiasSelect($('drw-parroquia'), codMun, codPar);
    $('drw-centro').value = r.centro_votacion || '';
    $('drw-correo').value = r.correo || '';
    $('drw-redes').value = r.redes_sociales || '';
    $('drw-comunidad').value = r.comunidad || '';
    $('drw-cal').value = r.comite_activismo_local || '';
    $('drw-resp-cal').value = r.responsable_cal || '';
    $('drw-resp-local').value = r.responsable_local || '';
    $('drw-resp-municipal').value = r.responsable_municipal || '';
    $('drw-enlace').value = r.enlace || '';

    toggleDrawerModo(iniciarEnEdicion);
    $('drawer-backdrop').classList.remove('hidden');
    $('drawer-panel').classList.remove('translate-x-full');
    refreshIcons();
  }

  function cerrarDrawer() {
    $('drawer-panel').classList.add('translate-x-full');
    $('drawer-backdrop').classList.add('hidden');
  }

  $('btn-cerrar-drawer').addEventListener('click', cerrarDrawer);
  $('drawer-backdrop').addEventListener('click', cerrarDrawer);
  $('btn-drawer-switch-edit').addEventListener('click', () => toggleDrawerModo(true));

  $('btn-drawer-imprimir').addEventListener('click', () => {
    cerrarDrawer();
    window.print();
  });

  $('drawer-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      cedula: $('drw-cedula').value,
      codigo: $('drw-codigo').value,
      nombre_apellido: $('drw-nombre').value,
      sexo: $('drw-sexo').value,
      telefono: $('drw-telefono').value,
      codigo_municipio: $('drw-municipio').value,
      codigo_parroquia: $('drw-parroquia').value,
      centro_votacion: $('drw-centro').value,
      correo: $('drw-correo').value,
      redes_sociales: $('drw-redes').value,
      comunidad: $('drw-comunidad').value,
      comite_activismo_local: $('drw-cal').value,
      responsable_cal: $('drw-resp-cal').value,
      responsable_local: $('drw-resp-local').value,
      responsable_municipal: $('drw-resp-municipal').value,
      enlace: $('drw-enlace').value,
    };

    try {
      await apiFetch('/api/activistas', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      cerrarDrawer();
      mostrarToast('Expediente actualizado correctamente.', 'ok');
      await Promise.all([cargarListado(), refrescarKPIs()]);
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  });

  $('btn-exportar-csv').addEventListener('click', async () => {
    const params = obtenerQueryFiltros();
    const qs = params.toString();
    const url = qs ? `/api/activistas/exportar-csv?${qs}` : '/api/activistas/exportar-csv';

    try {
      const res = await apiFetch(url);
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'activistas_ap_aragua.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      mostrarToast('Archivo CSV exportado para Excel.', 'ok');
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  });

  $('btn-imprimir').addEventListener('click', () => {
    const params = obtenerQueryFiltros();
    const partes = [];
    for (const [k, v] of params.entries()) partes.push(`${k}: ${v}`);
    $('print-fecha').textContent = `Fecha: ${new Date().toLocaleString('es-VE')}`;
    $('print-total').textContent = `Total de registros: ${STATE.ultimoListado.length}`;
    $('print-filtros-resumen').textContent =
      partes.length > 0 ? `Filtros aplicados: ${partes.join(' | ')}` : 'Listado General (Estado Aragua)';
    window.print();
  });

  // =========================================================
  // 5. VISTA 3: REPORTES Y ANALÍTICA (%)
  // =========================================================
  const SOFT_PALETTE = [
    '#3B82F6', '#6366F1', '#10B981', '#F59E0B', '#8B5CF6',
    '#14B8A6', '#60A5FA', '#818CF8', '#34D399', '#FBBF24',
  ];

  function agruparConteo(registros, extractor) {
    const map = new Map();
    for (const r of registros) {
      const key = extractor(r) || 'SIN ESPECIFICAR';
      map.set(key, (map.get(key) || 0) + 1);
    }
    const total = registros.length;
    return Array.from(map.entries())
      .map(([etiqueta, cantidad]) => ({
        etiqueta,
        cantidad,
        porcentaje: total ? Number(((cantidad * 100) / total).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.cantidad - a.cantidad);
  }

  function crearODestruirChart(key, canvasId, config) {
    if (STATE.charts[key]) {
      STATE.charts[key].destroy();
    }
    const ctx = $(canvasId).getContext('2d');
    STATE.charts[key] = new Chart(ctx, config);
  }

  $('stats-flt-municipio').addEventListener('change', (e) => {
    poblarParroquiasSelect($('stats-flt-parroquia'), e.target.value, '', 'Todas las Parroquias', false);
    renderizarAnalitica();
  });

  $('stats-flt-parroquia').addEventListener('change', renderizarAnalitica);

  async function renderizarAnalitica() {
    await refrescarKPIs();

    const todos = STATE.todosActivistas;
    const totalGlobal = todos.length;
    const codMunSel = $('stats-flt-municipio').value;
    const codParSel = $('stats-flt-parroquia').value;

    // Tablero Territorial de los 18 Municipios
    const conteoMun = new Map();
    for (const r of todos) {
      const cm = String(r.codigo_municipio || '').padStart(2, '0');
      conteoMun.set(cm, (conteoMun.get(cm) || 0) + 1);
    }

    const matrizEl = $('matriz-18-municipios');
    matrizEl.innerHTML = STATE.catalogo
      .map((m) => {
        const cnt = conteoMun.get(m.codigo) || 0;
        const pct = totalGlobal ? Number(((cnt * 100) / totalGlobal).toFixed(1)) : 0;
        const isSelected = codMunSel === m.codigo;
        return `
          <button
            type="button"
            data-sala-mun="${escapeHtml(m.codigo)}"
            class="sala-mun-card cursor-pointer text-left bg-white rounded-xl border p-3 transition-all hover:border-blue-300 ${
              isSelected ? 'border-[#2563EB] ring-2 ring-blue-500/15 bg-blue-50/40' : 'border-slate-200'
            }"
          >
            <div class="flex items-center justify-between text-[11px] font-mono font-semibold">
              <span class="${isSelected ? 'text-[#2563EB]' : 'text-slate-400'}">${escapeHtml(m.codigo)}</span>
              <span class="text-[#2563EB]">${pct}%</span>
            </div>
            <p class="text-xs font-bold text-slate-800 truncate mt-1" title="${escapeHtml(m.nombre)}">${escapeHtml(m.nombre)}</p>
            <p class="text-base font-mono font-bold text-slate-800 mt-0.5">${cnt}</p>
            <div class="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1.5">
              <div class="h-full bg-[#3B82F6] rounded-full" style="width: ${Math.min(100, pct)}%"></div>
            </div>
          </button>`;
      })
      .join('');

    matrizEl.querySelectorAll('.sala-mun-card').forEach((card) => {
      card.addEventListener('click', () => {
        const cm = card.dataset.salaMun;
        const nuevo = codMunSel === cm ? '' : cm;
        $('stats-flt-municipio').value = nuevo;
        poblarParroquiasSelect($('stats-flt-parroquia'), nuevo, '', 'Todas las Parroquias', false);
        renderizarAnalitica();
      });
    });

    const filtrados = todos.filter((r) => {
      if (codMunSel && String(r.codigo_municipio).padStart(2, '0') !== codMunSel) return false;
      if (codParSel && String(r.codigo_parroquia).padStart(2, '0') !== codParSel) return false;
      return true;
    });

    $('stats-total-universo').textContent = filtrados.length;

    const porMunicipio = agruparConteo(filtrados, (r) => r.municipio);
    const porParroquia = agruparConteo(filtrados, (r) =>
      r.parroquia ? `${r.parroquia} (${r.municipio || ''})` : 'SIN ESPECIFICAR'
    );
    const porCentro = agruparConteo(filtrados, (r) => r.centro_votacion);
    const porComunidad = agruparConteo(filtrados, (r) => r.comunidad);
    const porRespMun = agruparConteo(filtrados, (r) => r.responsable_municipal);
    const porRespCal = agruparConteo(filtrados, (r) => r.responsable_cal);
    const porParCom = agruparConteo(filtrados, (r) =>
      `${r.parroquia || 'N/A'} / ${r.comunidad || 'N/A'}`
    );

    // 1. Doughnut % Por Municipio
    crearODestruirChart('municipio', 'chart-municipio', {
      type: 'doughnut',
      data: {
        labels: porMunicipio.slice(0, 10).map((x) => `${x.etiqueta} (${x.porcentaje}%)`),
        datasets: [
          {
            data: porMunicipio.slice(0, 10).map((x) => x.cantidad),
            backgroundColor: SOFT_PALETTE,
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
      },
    });

    // 2. Horizontal Bar % Por Parroquia y Comunidad
    const topParCom = porParCom.slice(0, 8);
    crearODestruirChart('parroquiaComunidad', 'chart-parroquia-comunidad', {
      type: 'bar',
      data: {
        labels: topParCom.map((x) => x.etiqueta),
        datasets: [
          {
            label: '% Participación',
            data: topParCom.map((x) => x.porcentaje),
            backgroundColor: '#3B82F6',
            borderRadius: 6,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { max: 100, ticks: { callback: (v) => v + '%' } } },
      },
    });

    // 3. Doughnut % Por Centro de Votación
    const topCentros = porCentro.slice(0, 8);
    crearODestruirChart('centro', 'chart-centro', {
      type: 'doughnut',
      data: {
        labels: topCentros.map((x) => `${x.etiqueta} (${x.porcentaje}%)`),
        datasets: [
          {
            data: topCentros.map((x) => x.cantidad),
            backgroundColor: SOFT_PALETTE.slice().reverse(),
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 10 } } } },
      },
    });

    // 4. Vertical Bar Rendimiento Responsables
    const topRM = porRespMun.slice(0, 5);
    const topRC = porRespCal.slice(0, 5);
    crearODestruirChart('responsables', 'chart-responsables', {
      type: 'bar',
      data: {
        labels: [
          ...topRM.map((x) => `Mun: ${x.etiqueta}`),
          ...topRC.map((x) => `CAL: ${x.etiqueta}`),
        ],
        datasets: [
          {
            label: '% Estructura',
            data: [...topRM.map((x) => x.porcentaje), ...topRC.map((x) => x.porcentaje)],
            backgroundColor: [
              ...topRM.map(() => '#10B981'),
              ...topRC.map(() => '#6366F1'),
            ],
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { max: 100, ticks: { callback: (v) => v + '%' } } },
      },
    });

    // 6 Tablas Detalladas de Porcentajes Exactos (%)
    const tarjetas = [
      { titulo: '1. % Por Centro de Votación', items: porCentro, color: 'bg-[#3B82F6]' },
      { titulo: '2. % Por Parroquia', items: porParroquia, color: 'bg-[#6366F1]' },
      { titulo: '3. % Por Municipio', items: porMunicipio, color: 'bg-[#2563EB]' },
      { titulo: '4. % Por Comunidad', items: porComunidad, color: 'bg-[#F59E0B]' },
      { titulo: '5. % Por Responsable Municipal', items: porRespMun, color: 'bg-[#10B981]' },
      { titulo: '6. % Por Responsable del CAL', items: porRespCal, color: 'bg-[#8B5CF6]' },
    ];

    $('stats-grid').innerHTML = tarjetas
      .map((t) => {
        const filas = t.items.length
          ? t.items
              .map(
                (it) => `
              <div class="space-y-1">
                <div class="flex items-center justify-between text-xs gap-2">
                  <span class="font-medium text-slate-700 truncate" title="${escapeHtml(it.etiqueta)}">${escapeHtml(it.etiqueta)}</span>
                  <span class="font-mono font-semibold text-slate-700 shrink-0">${it.cantidad} (${it.porcentaje}%)</span>
                </div>
                <div class="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div class="h-full ${t.color} rounded-full" style="width: ${Math.min(100, it.porcentaje)}%"></div>
                </div>
              </div>`
              )
              .join('')
          : '<p class="text-xs text-slate-400 py-4 text-center">Sin datos registrados para esta selección.</p>';

        return `
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col max-h-96">
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-700 border-b border-slate-100 pb-2.5 mb-3">${escapeHtml(t.titulo)}</h4>
            <div class="space-y-3 overflow-y-auto pr-1 flex-1">${filas}</div>
          </div>`;
      })
      .join('');
  }

  refreshIcons();
  if (STATE.token) {
    inicializarSesion().catch(() => cerrarSesionLocal());
  }
})();

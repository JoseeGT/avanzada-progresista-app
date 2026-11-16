(() => {
  'use strict';

  const STATE = {
    token: sessionStorage.getItem('ap_token') || '',
    catalogo: [],
    modoEdicion: false,
    registroModo: 'grupal', // 'grupal' | 'individual'
    ultimoCodigoSugeridoGrupal: '',
    ultimoListado: [],
    todosActivistas: [],
    estructura: [],
    estRolFiltro: '',
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

  function retriggerAnim(el, className) {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  function animarNumeroKPI(el, targetVal) {
    if (!el) return;
    const end = Number(targetVal) || 0;
    const start = Number(el.textContent) || 0;
    if (start === end) {
      el.textContent = String(end);
      return;
    }
    const dur = 320;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(start + (end - start) * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
    retriggerAnim(box, 'animate-toast-in');
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
    requestAnimationFrame(() => actualizarPillModoCarga(false));
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
    await Promise.all([cargarCatalogo(), cargarEstadoSistema(), refrescarKPIs(), cargarEstructura()]);
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

      animarNumeroKPI($('kpi-total-activistas'), total);
      animarNumeroKPI($('kpi-municipios-activos'), munCount);
      $('kpi-municipios-pct').textContent = `${munPct}%`;
      $('kpi-municipios-bar').style.width = `${munPct}%`;
      animarNumeroKPI($('kpi-cals-activos'), calsSet.size);
      animarNumeroKPI($('kpi-centros-cubiertos'), centrosSet.size);
      renderizarChipsMunicipios();
    } catch (_) {}
  }

  const VIEW_TITLES = {
    registro: 'Recepción y Registro',
    listados: 'Directorio de Activistas',
    estructura: 'Estructura y Responsables',
    estadisticas: 'Reportes y Analítica (%)',
  };

  function activarTab(tabName) {
    ['registro', 'listados', 'estructura', 'estadisticas'].forEach((t) => {
      const sec = $(`tab-${t}`);
      if (t === tabName) {
        sec.classList.remove('hidden');
        retriggerAnim(sec, 'animate-view-enter');
      } else {
        sec.classList.add('hidden');
      }
    });

    document.querySelectorAll('.nav-item').forEach((btn) => {
      const icon = btn.querySelector('.nav-icon');
      if (btn.dataset.tab === tabName) {
        btn.classList.add('bg-blue-600/15', 'text-white', 'border-blue-500/30', 'font-semibold');
        btn.classList.remove('text-slate-300', 'hover:bg-slate-800/70', 'hover:text-white', 'border-transparent', 'font-medium');
        if (icon) icon.classList.add('text-blue-400');
      } else {
        btn.classList.remove('bg-blue-600/15', 'text-white', 'border-blue-500/30', 'font-semibold');
        btn.classList.add('text-slate-300', 'hover:bg-slate-800/70', 'hover:text-white', 'border-transparent', 'font-medium');
        if (icon) icon.classList.remove('text-blue-400');
      }
    });

    $('topbar-view-title').textContent = VIEW_TITLES[tabName] || 'Panel Electoral';
    toggleSidebarMobile(false);

    if (tabName === 'registro') {
      requestAnimationFrame(() => actualizarPillModoCarga(false));
    } else if (tabName === 'listados') {
      cargarListado();
    } else if (tabName === 'estructura') {
      cargarEstructura();
    } else if (tabName === 'estadisticas') {
      renderizarAnalitica();
    }
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => activarTab(btn.dataset.tab));
  });

  $('btn-nuevo-registro-sidebar').addEventListener('click', () => {
    activarTab('registro');
    if (STATE.registroModo === 'grupal') {
      limpiarPlanillaGrupal();
      $('grp-codigo').focus();
    } else {
      $('cne-cedula-search').value = '';
      limpiarFormulario();
      $('cne-cedula-search').focus();
    }
  });

  $('topbar-quick-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = $('topbar-quick-search').value.replace(/\D/g, '');
      if (q.length >= 5) {
        setRegistroModo('individual');
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
      { el: $('grp-municipio'), placeholder: 'Seleccione municipio...' },
      { el: $('form-municipio'), placeholder: 'Seleccione municipio...' },
      { el: $('flt-municipio'), placeholder: 'Todos los Municipios' },
      { el: $('drw-municipio'), placeholder: 'Seleccione municipio...' },
      { el: $('stats-flt-municipio'), placeholder: 'Todos los Municipios (Aragua)' },
      { el: $('est-municipio'), placeholder: 'Todos / No especificado' },
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
    await actualizarCodigoSiguienteGrupal('01');
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

  async function actualizarCodigoSiguienteGrupal(codMun, forzar = false) {
    if (!codMun) return;
    const actual = $('grp-codigo').value.trim();
    if (!forzar && actual && actual !== STATE.ultimoCodigoSugeridoGrupal) return;
    try {
      const res = await apiFetch(`/api/activistas/codigo-siguiente/${encodeURIComponent(codMun)}`);
      const data = await res.json();
      $('grp-codigo').value = data.codigo;
      STATE.ultimoCodigoSugeridoGrupal = data.codigo;
    } catch (_) {}
  }

  $('grp-municipio').addEventListener('change', async (e) => {
    const codMun = e.target.value;
    poblarParroquiasSelect($('grp-parroquia'), codMun);
    await actualizarCodigoSiguienteGrupal(codMun || '01');
  });

  $('form-municipio').addEventListener('change', async (e) => {
    const codMun = e.target.value;
    poblarParroquiasSelect($('form-parroquia'), codMun);
    await actualizarCodigoSiguiente(codMun || '01');
  });

  $('flt-municipio').addEventListener('change', (e) => {
    poblarParroquiasSelect($('flt-parroquia'), e.target.value, '', 'Todas las Parroquias', true);
    renderizarChipsMunicipios();
    aplicarFiltrosEnMemoria();
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
    aplicarFiltrosEnMemoria();
  });

  $('drw-municipio').addEventListener('change', (e) => {
    poblarParroquiasSelect($('drw-parroquia'), e.target.value);
  });

  // =========================================================
  // 3. VISTA 1: RECEPCIÓN Y REGISTRO (GRUPAL + INDIVIDUAL)
  // =========================================================
  const MODO_BTN_BASE =
    'relative z-10 cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-200 sm:whitespace-nowrap';
  const MODO_ANIM_CLASSES = [
    'animate-view-enter',
    'animate-modo-enter-left',
    'animate-modo-enter-right',
    'animate-modo-exit-left',
    'animate-modo-exit-right',
    'pointer-events-none',
    'absolute',
    'top-0',
    'left-0',
    'right-0',
    'z-0',
    'relative',
    'z-10',
  ];

  function actualizarPillModoCarga(animar = true) {
    const pill = $('modo-carga-pill');
    const btnActivo = $(STATE.registroModo === 'grupal' ? 'btn-modo-grupal' : 'btn-modo-individual');
    if (!pill || !btnActivo || !btnActivo.offsetWidth) return;

    const aplicar = () => {
      pill.style.width = `${btnActivo.offsetWidth}px`;
      pill.style.transform = `translateX(${btnActivo.offsetLeft}px)`;
      pill.style.opacity = '1';
    };

    if (!animar) {
      pill.style.transition = 'none';
      aplicar();
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      aplicar();
    }
  }

  function limpiarEstadoAnimModo(el) {
    if (!el) return;
    clearTimeout(el._modoExitTimer);
    el.classList.remove(...MODO_ANIM_CLASSES);
  }

  function setRegistroModo(modo) {
    const prevModo = STATE.registroModo;
    STATE.registroModo = modo;
    const esGrupal = modo === 'grupal';
    const grupalEl = $('modo-planilla-grupal');
    const indivEl = $('modo-registro-individual');

    const btnGrupal = $('btn-modo-grupal');
    const btnIndiv = $('btn-modo-individual');
    btnGrupal.className = `${MODO_BTN_BASE} ${esGrupal ? 'text-[#2563EB]' : 'text-slate-600 hover:text-slate-900'}`;
    btnIndiv.className = `${MODO_BTN_BASE} ${!esGrupal ? 'text-[#2563EB]' : 'text-slate-600 hover:text-slate-900'}`;
    btnGrupal.setAttribute('aria-selected', esGrupal ? 'true' : 'false');
    btnIndiv.setAttribute('aria-selected', !esGrupal ? 'true' : 'false');

    actualizarPillModoCarga(true);

    if (prevModo === modo) {
      limpiarEstadoAnimModo(grupalEl);
      limpiarEstadoAnimModo(indivEl);
      grupalEl.classList.toggle('hidden', !esGrupal);
      indivEl.classList.toggle('hidden', esGrupal);
      return;
    }

    const outgoing = esGrupal ? indivEl : grupalEl;
    const incoming = esGrupal ? grupalEl : indivEl;
    const haciaDerecha = modo === 'individual';

    limpiarEstadoAnimModo(outgoing);
    limpiarEstadoAnimModo(incoming);

    outgoing.classList.remove('hidden');
    outgoing.classList.add('pointer-events-none', 'absolute', 'top-0', 'left-0', 'right-0', 'z-0');
    retriggerAnim(outgoing, haciaDerecha ? 'animate-modo-exit-left' : 'animate-modo-exit-right');
    outgoing._modoExitTimer = setTimeout(() => {
      outgoing.classList.add('hidden');
      limpiarEstadoAnimModo(outgoing);
    }, 210);

    incoming.classList.remove('hidden');
    incoming.classList.add('relative', 'z-10');
    retriggerAnim(incoming, haciaDerecha ? 'animate-modo-enter-right' : 'animate-modo-enter-left');

    const descEl = $('registro-modo-desc');
    descEl.textContent = esGrupal
      ? 'Carga rápida por planilla física: llene la cabecera una vez y agregue la lista de personas.'
      : 'Consulta individual en Padrón CNE y edición de expediente de una sola persona.';
    retriggerAnim(descEl, 'animate-modo-desc');
  }

  $('btn-modo-grupal').addEventListener('click', () => setRegistroModo('grupal'));
  $('btn-modo-individual').addEventListener('click', () => setRegistroModo('individual'));
  window.addEventListener('resize', () => actualizarPillModoCarga(false));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => actualizarPillModoCarga(false));
  }
  requestAnimationFrame(() => actualizarPillModoCarga(false));

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

  const REDES_PLATAFORMAS = [
    'Instagram',
    'Facebook',
    'X (Twitter)',
    'TikTok',
    'YouTube',
    'Telegram',
    'Otra',
  ];

  function parsearRedesSociales(texto) {
    const raw = String(texto || '').trim();
    if (!raw) return [];
    const partes = raw.split(/\s*(?:,|\||;)\s*/).filter(Boolean);
    return partes.map((parte) => {
      const idx = parte.indexOf(':');
      if (idx > 0) {
        const posiblePlat = parte.slice(0, idx).trim();
        const resto = parte.slice(idx + 1).trim();
        const match = REDES_PLATAFORMAS.find(
          (p) => p.toLowerCase() === posiblePlat.toLowerCase()
        );
        if (match && resto) {
          return { plataforma: match, usuario: resto };
        }
      }
      return { plataforma: '', usuario: parte };
    });
  }

  function construirUrlRedSocial(plataforma, usuario) {
    const raw = String(usuario || '').trim();
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
      } catch {
        return null;
      }
    }

    if (/^(www\.)?[a-z0-9-]+\.[a-z]{2,}\//i.test(raw)) {
      try {
        const u = new URL(`https://${raw}`);
        return u.href;
      } catch {
        return null;
      }
    }

    const handle = raw.replace(/^@+/, '').trim();
    if (!handle || /\s/.test(handle)) return null;

    const bases = {
      Instagram: (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`,
      Facebook: (h) => `https://www.facebook.com/${encodeURIComponent(h)}`,
      'X (Twitter)': (h) => `https://x.com/${encodeURIComponent(h)}`,
      TikTok: (h) => `https://www.tiktok.com/@${encodeURIComponent(h)}`,
      YouTube: (h) => `https://www.youtube.com/@${encodeURIComponent(h)}`,
      Telegram: (h) => `https://t.me/${encodeURIComponent(h)}`,
    };
    const builder = bases[plataforma];
    return builder ? builder(handle) : null;
  }

  function crearFilaRedSocial(containerEl, plataforma = '', usuario = '', compact = false) {
    const row = document.createElement('div');
    row.className = 'red-social-row flex items-center gap-2';

    const select = document.createElement('select');
    select.className = `red-plataforma ${
      compact ? 'w-28 px-2 py-1.5 text-xs' : 'w-36 px-2.5 py-2 text-sm'
    } border border-slate-300 rounded-xl bg-white outline-none focus:border-[#2563EB] shrink-0`;
    const optDefault = document.createElement('option');
    optDefault.value = '';
    optDefault.textContent = 'Red...';
    select.appendChild(optDefault);
    REDES_PLATAFORMAS.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      if (p === plataforma) opt.selected = true;
      select.appendChild(opt);
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.value = usuario;
    input.placeholder = '@usuario o enlace';
    input.className = `red-usuario flex-1 min-w-0 ${
      compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'
    } border border-slate-300 rounded-xl outline-none focus:border-[#2563EB]`;

    const linkOpen = document.createElement('a');
    linkOpen.target = '_blank';
    linkOpen.rel = 'noopener noreferrer';
    linkOpen.title = 'Abrir perfil / contactar';
    linkOpen.className = `hidden ${
      compact ? 'p-1.5' : 'p-2'
    } rounded-xl text-[#2563EB] bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors shrink-0 items-center justify-center`;
    linkOpen.innerHTML = '<i data-lucide="external-link" class="w-3.5 h-3.5"></i>';

    const actualizarEnlaceFila = () => {
      const url = construirUrlRedSocial(select.value, input.value);
      if (url) {
        linkOpen.href = url;
        linkOpen.classList.remove('hidden');
        linkOpen.classList.add('inline-flex');
      } else {
        linkOpen.removeAttribute('href');
        linkOpen.classList.add('hidden');
        linkOpen.classList.remove('inline-flex');
      }
    };
    select.addEventListener('change', actualizarEnlaceFila);
    input.addEventListener('input', actualizarEnlaceFila);

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.title = 'Quitar red social';
    btnDel.className = `cursor-pointer ${
      compact ? 'p-1.5' : 'p-2'
    } rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 border border-slate-200 transition-colors shrink-0`;
    btnDel.innerHTML = '<i data-lucide="x" class="w-3.5 h-3.5"></i>';
    btnDel.addEventListener('click', () => {
      if (containerEl.querySelectorAll('.red-social-row').length > 1) {
        row.remove();
      } else {
        select.value = '';
        input.value = '';
        actualizarEnlaceFila();
      }
    });

    row.appendChild(select);
    row.appendChild(input);
    row.appendChild(linkOpen);
    row.appendChild(btnDel);
    containerEl.appendChild(row);
    actualizarEnlaceFila();
    refreshIcons();
  }

  function cargarRedesEnContenedor(containerEl, texto, compact = false) {
    containerEl.innerHTML = '';
    const items = parsearRedesSociales(texto);
    if (!items.length) {
      crearFilaRedSocial(containerEl, '', '', compact);
      return;
    }
    items.forEach((it) => crearFilaRedSocial(containerEl, it.plataforma, it.usuario, compact));
  }

  function serializarRedesSociales(containerEl) {
    const valores = [];
    containerEl.querySelectorAll('.red-social-row').forEach((row) => {
      const plat = row.querySelector('.red-plataforma').value.trim();
      const usr = row.querySelector('.red-usuario').value.trim();
      if (!usr) return;
      valores.push(plat ? `${plat}: ${usr}` : usr);
    });
    return valores.join(', ');
  }

  $('btn-add-form-red').addEventListener('click', () => {
    crearFilaRedSocial($('form-redes-list'), '', '', false);
  });
  $('btn-add-drw-red').addEventListener('click', () => {
    crearFilaRedSocial($('drw-redes-list'), '', '', true);
  });
  cargarRedesEnContenedor($('form-redes-list'), '', false);

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
    cargarRedesEnContenedor($('form-redes-list'), '', false);
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
    $('form-direccion').value = d.direccion || '';
    $('form-telefono').value = d.telefono || '';
    $('form-correo').value = d.correo || '';
    cargarRedesEnContenedor($('form-redes-list'), d.redes_sociales || '', false);
    $('form-cal').value = d.comite_activismo_local || '';
    $('form-direccion-cal').value = d.direccion_cal || '';
    $('form-resp-cal').value = d.responsable_cal || '';
    $('form-resp-local').value = d.responsable_local || '';
    $('form-resp-comunidad').value = d.responsable_comunidad || '';
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
      codigo: $('form-codigo').value.trim(),
      nombre_apellido: $('form-nombre').value,
      sexo: $('form-sexo').value,
      codigo_municipio: $('form-municipio').value,
      codigo_parroquia: $('form-parroquia').value,
      centro_votacion: $('form-centro').value,
      direccion: $('form-direccion').value,
      telefono: $('form-telefono').value,
      correo: $('form-correo').value,
      redes_sociales: serializarRedesSociales($('form-redes-list')),
      comunidad: $('form-comunidad').value,
      enlace: $('form-enlace').value,
      responsable_municipal: $('form-resp-municipal').value,
      responsable_comunidad: $('form-resp-comunidad').value,
      responsable_cal: $('form-resp-cal').value,
      responsable_local: $('form-resp-local').value,
      comite_activismo_local: $('form-cal').value,
      direccion_cal: $('form-direccion-cal').value,
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
      await Promise.all([refrescarKPIs(), cargarEstructura()]);
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
  // 3B. PLANILLA GRUPAL EN FORMATO DE LISTA
  // =========================================================
  function renumerarFilasPlanilla() {
    $('grp-filas-body')
      .querySelectorAll('.grp-row')
      .forEach((tr, idx) => {
        const numCell = tr.querySelector('.grp-row-num');
        if (numCell) numCell.textContent = String(idx + 1);
      });
  }

  function actualizarResumenPlanilla() {
    let listas = 0;
    let existentes = 0;
    $('grp-filas-body')
      .querySelectorAll('.grp-row')
      .forEach((tr) => {
        const ced = tr.querySelector('.grp-cedula').value.replace(/\D/g, '');
        if (ced.length >= 5) {
          listas += 1;
          if (tr.dataset.estado === 'activistas') existentes += 1;
        }
      });
    const nuevos = listas - existentes;
    $('grp-resumen-filas').textContent = `${listas} persona(s) lista(s) para guardar (${nuevos} nueva(s), ${existentes} actualización(es))`;
  }

  function setEstadoFilaPlanilla(tr, tipo, textoCentro = '') {
    tr.dataset.estado = tipo;
    const badge = tr.querySelector('.grp-estado-badge');
    const sub = tr.querySelector('.grp-centro-cne');

    if (tipo === 'padron') {
      badge.className = 'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
      badge.textContent = 'CNE OK';
    } else if (tipo === 'activistas') {
      badge.className = 'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-200';
      badge.textContent = 'Ya existe';
    } else if (tipo === 'ninguno') {
      badge.className = 'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200';
      badge.textContent = 'Manual';
    } else if (tipo === 'buscando') {
      badge.className = 'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-[#2563EB] border border-blue-200';
      badge.textContent = 'Buscando...';
    } else {
      badge.className = 'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-400 border border-slate-200';
      badge.textContent = 'Pendiente';
    }

    sub.textContent = textoCentro;
    sub.title = textoCentro;
  }

  async function consultarCedulaFilaPlanilla(tr, forzar = false) {
    const inputCed = tr.querySelector('.grp-cedula');
    const raw = inputCed.value.replace(/\D/g, '');
    inputCed.value = raw;

    if (raw.length < 5) {
      if (forzar && raw.length > 0) {
        mostrarToast('La cédula debe tener al menos 5 dígitos.', 'error');
      }
      tr.dataset.lastCedula = '';
      tr.dataset.cneMun = '';
      tr.dataset.cnePar = '';
      tr.dataset.cneCentro = '';
      setEstadoFilaPlanilla(tr, 'pendiente', '');
      actualizarResumenPlanilla();
      return;
    }

    if (!forzar && tr.dataset.lastCedula === raw) return;
    tr.dataset.lastCedula = raw;
    setEstadoFilaPlanilla(tr, 'buscando', '');

    try {
      const res = await apiFetch(`/api/elector/${encodeURIComponent(raw)}`);
      const data = await res.json();
      const d = data.datos || {};

      tr.dataset.cneMun = d.codigo_municipio || '';
      tr.dataset.cnePar = d.codigo_parroquia || '';
      tr.dataset.cneCentro = d.centro_votacion || '';

      if (d.nombre_apellido) {
        tr.querySelector('.grp-nombre').value = d.nombre_apellido;
      }
      if (d.sexo) {
        tr.querySelector('.grp-sexo').value = d.sexo;
      }

      if (data.encontrado_en === 'activistas') {
        if (d.telefono) tr.querySelector('.grp-telefono').value = d.telefono;
        if (d.correo) tr.querySelector('.grp-correo').value = d.correo;
        if (d.direccion) tr.querySelector('.grp-direccion').value = d.direccion;
        if (d.redes_sociales) {
          cargarRedesEnContenedor(tr.querySelector('.grp-redes-list'), d.redes_sociales, true);
        }
        setEstadoFilaPlanilla(tr, 'activistas', d.centro_votacion || '');
        retriggerAnim(tr, 'animate-cne-flash');
      } else if (data.encontrado_en === 'padron') {
        setEstadoFilaPlanilla(tr, 'padron', d.centro_votacion || '');
        retriggerAnim(tr, 'animate-cne-flash');
      } else {
        setEstadoFilaPlanilla(tr, 'ninguno', 'No hallado en CNE');
      }
    } catch (err) {
      tr.dataset.lastCedula = '';
      setEstadoFilaPlanilla(tr, 'pendiente', '');
      mostrarToast(err.message, 'error');
    }
    actualizarResumenPlanilla();
  }

  function agregarFilaPlanilla(cantidad = 1) {
    const tbody = $('grp-filas-body');
    for (let i = 0; i < cantidad; i += 1) {
      const tr = document.createElement('tr');
      tr.className = 'grp-row hover:bg-blue-50/20 align-top';
      tr.dataset.estado = 'pendiente';
      tr.innerHTML = `
        <td class="grp-row-num px-2.5 py-2.5 text-center font-mono font-bold text-slate-400"></td>
        <td class="px-2 py-2">
          <div class="flex items-center gap-1">
            <input type="text" inputmode="numeric" placeholder="Cédula" class="grp-cedula w-24 px-2 py-1.5 font-mono text-xs border border-slate-300 rounded-lg outline-none focus:border-[#2563EB]" />
            <button type="button" title="Consultar en Padrón CNE" class="grp-btn-cne cursor-pointer p-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] border border-blue-200/80 shrink-0">
              <i data-lucide="search" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </td>
        <td class="px-2 py-2">
          <input type="text" placeholder="Nombre y apellido" class="grp-nombre w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg outline-none focus:border-[#2563EB]" />
        </td>
        <td class="px-2 py-2">
          <select class="grp-sexo w-full px-1.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white outline-none focus:border-[#2563EB]">
            <option value="">-</option>
            <option value="H">H</option>
            <option value="M">M</option>
          </select>
        </td>
        <td class="px-2 py-2">
          <input type="text" placeholder="0412-..." class="grp-telefono w-full px-2 py-1.5 font-mono text-xs border border-slate-300 rounded-lg outline-none focus:border-[#2563EB]" />
        </td>
        <td class="px-2 py-2">
          <input type="email" placeholder="correo@..." class="grp-correo w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg outline-none focus:border-[#2563EB]" />
        </td>
        <td class="px-2 py-2">
          <input type="text" placeholder="Dirección" class="grp-direccion w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg outline-none focus:border-[#2563EB]" />
        </td>
        <td class="px-2 py-2">
          <div class="flex items-start gap-1.5">
            <div class="grp-redes-list space-y-1.5 flex-1 min-w-0"></div>
            <button type="button" title="Agregar otra red social" class="grp-btn-add-red cursor-pointer p-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] border border-blue-200/80 shrink-0">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </td>
        <td class="px-2 py-2">
          <span class="grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-400 border border-slate-200">Pendiente</span>
          <p class="grp-centro-cne text-[10px] text-slate-500 mt-1 max-w-[125px] truncate"></p>
        </td>
        <td class="px-2 py-2 text-center">
          <button type="button" title="Quitar fila" class="grp-btn-del cursor-pointer p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </td>
      `;

      const redesBox = tr.querySelector('.grp-redes-list');
      cargarRedesEnContenedor(redesBox, '', true);

      const inputCed = tr.querySelector('.grp-cedula');
      inputCed.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          consultarCedulaFilaPlanilla(tr, true);
        }
      });
      inputCed.addEventListener('blur', () => consultarCedulaFilaPlanilla(tr, false));
      inputCed.addEventListener('input', actualizarResumenPlanilla);

      tr.querySelector('.grp-btn-cne').addEventListener('click', () => {
        consultarCedulaFilaPlanilla(tr, true);
      });

      tr.querySelector('.grp-btn-add-red').addEventListener('click', () => {
        crearFilaRedSocial(redesBox, '', '', true);
      });

      tr.querySelector('.grp-btn-del').addEventListener('click', () => {
        if (tbody.querySelectorAll('.grp-row').length > 1) {
          tr.remove();
          renumerarFilasPlanilla();
          actualizarResumenPlanilla();
        } else {
          tr.querySelectorAll('input, select').forEach((el) => { el.value = ''; });
          tr.dataset.lastCedula = '';
          tr.dataset.cneMun = '';
          tr.dataset.cnePar = '';
          tr.dataset.cneCentro = '';
          cargarRedesEnContenedor(redesBox, '', true);
          setEstadoFilaPlanilla(tr, 'pendiente', '');
          actualizarResumenPlanilla();
        }
      });

      tbody.appendChild(tr);
    }
    renumerarFilasPlanilla();
    actualizarResumenPlanilla();
    refreshIcons();
  }

  function limpiarPlanillaGrupal() {
    $('planilla-grupal-form').reset();
    $('grp-parroquia').innerHTML = '<option value="">Seleccione parroquia...</option>';
    $('grp-filas-body').innerHTML = '';
    STATE.ultimoCodigoSugeridoGrupal = '';
    agregarFilaPlanilla(5);
    actualizarCodigoSiguienteGrupal('01', true);
  }

  $('btn-grp-add-1').addEventListener('click', () => agregarFilaPlanilla(1));
  $('btn-grp-add-5').addEventListener('click', () => agregarFilaPlanilla(5));
  $('btn-limpiar-planilla').addEventListener('click', limpiarPlanillaGrupal);
  agregarFilaPlanilla(5);

  $('planilla-grupal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const codMunHdr = $('grp-municipio').value;
    const codParHdr = $('grp-parroquia').value;
    if (!codMunHdr || !codParHdr) {
      mostrarToast('Seleccione el Municipio y la Parroquia en la cabecera de la planilla.', 'error');
      return;
    }

    const codigoPlanilla = $('grp-codigo').value.trim().toUpperCase();
    const cabecera = {
      codigo: codigoPlanilla,
      comunidad: $('grp-comunidad').value,
      comite_activismo_local: $('grp-cal').value,
      direccion_cal: $('grp-direccion-cal').value,
      responsable_cal: $('grp-resp-cal').value,
      enlace: $('grp-enlace').value,
      responsable_local: $('grp-resp-local').value,
      responsable_comunidad: $('grp-resp-comunidad').value,
      responsable_municipal: $('grp-resp-municipal').value,
    };
    const centroCercanoHdr = $('grp-centro').value.trim();

    const activistas = [];
    const cedulasVistas = new Set();
    let filaError = '';

    $('grp-filas-body')
      .querySelectorAll('.grp-row')
      .forEach((tr, idx) => {
        if (filaError) return;
        const nFila = idx + 1;
        const ced = tr.querySelector('.grp-cedula').value.replace(/\D/g, '');
        const nombre = tr.querySelector('.grp-nombre').value.trim();
        const tel = tr.querySelector('.grp-telefono').value.trim();
        const correo = tr.querySelector('.grp-correo').value.trim();
        const dir = tr.querySelector('.grp-direccion').value.trim();
        const redes = serializarRedesSociales(tr.querySelector('.grp-redes-list'));

        const tieneAlgunDato = Boolean(ced || nombre || tel || correo || dir || redes);
        if (!tieneAlgunDato) return;

        if (ced.length < 5 || ced.length > 12) {
          filaError = `Fila #${nFila}: la cédula debe tener entre 5 y 12 dígitos.`;
          return;
        }
        if (cedulasVistas.has(ced)) {
          filaError = `Fila #${nFila}: la cédula ${ced} está repetida en esta misma planilla.`;
          return;
        }
        if (nombre.length < 2) {
          filaError = `Fila #${nFila}: falta el Nombre y Apellido (consulte el CNE o escríbalo).`;
          return;
        }
        cedulasVistas.add(ced);

        activistas.push(
          Object.assign({}, cabecera, {
            cedula: ced,
            nombre_apellido: nombre,
            sexo: tr.querySelector('.grp-sexo').value,
            telefono: tel,
            correo,
            direccion: dir,
            redes_sociales: redes,
            codigo_municipio: tr.dataset.cneMun || codMunHdr,
            codigo_parroquia: tr.dataset.cnePar || codParHdr,
            centro_votacion: tr.dataset.cneCentro || centroCercanoHdr,
          })
        );
      });

    if (filaError) {
      mostrarToast(filaError, 'error');
      return;
    }
    if (!activistas.length) {
      mostrarToast('Ingrese al menos una persona en la lista antes de guardar.', 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/activistas/lote', {
        method: 'POST',
        body: JSON.stringify({ activistas }),
      });
      const data = await res.json();
      mostrarToast(
        `Planilla ${data.codigo_planilla} guardada: ${data.total_procesados} persona(s) (${data.nuevos} nueva(s), ${data.actualizados} actualizada(s)).`,
        'ok'
      );
      limpiarPlanillaGrupal();
      await Promise.all([refrescarKPIs(), cargarEstructura()]);
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
        aplicarFiltrosEnMemoria();
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
      responsable_comunidad: $('flt-resp-comunidad').value.trim(),
      enlace: $('flt-enlace').value.trim(),
      responsable_cal: $('flt-resp-cal').value.trim(),
      responsable_local: $('flt-resp-local').value.trim(),
    };
    for (const [k, v] of Object.entries(mapa)) {
      if (v) params.set(k, v);
    }
    return params;
  }

  function normalizarFiltroTexto(val) {
    return String(val || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function aplicarFiltrosEnMemoria() {
    const cedQ = $('flt-cedula').value.replace(/\D/g, '');
    const codQ = normalizarFiltroTexto($('flt-codigo').value);
    const munRaw = $('flt-municipio').value.trim();
    const munQ = munRaw ? munRaw.padStart(2, '0') : '';
    const parRaw = $('flt-parroquia').value.trim();
    const parQ = parRaw ? parRaw.padStart(2, '0') : '';
    const centroQ = normalizarFiltroTexto($('flt-centro').value);
    const comunidadQ = normalizarFiltroTexto($('flt-comunidad').value);
    const respComQ = normalizarFiltroTexto($('flt-resp-comunidad').value);
    const enlaceQ = normalizarFiltroTexto($('flt-enlace').value);
    const respCalQ = normalizarFiltroTexto($('flt-resp-cal').value);
    const respLocQ = normalizarFiltroTexto($('flt-resp-local').value);

    const resultados = STATE.todosActivistas
      .filter((r) => {
        if (cedQ && !String(r.cedula || '').includes(cedQ)) return false;
        if (codQ && !normalizarFiltroTexto(r.codigo).includes(codQ)) return false;
        if (munQ && String(r.codigo_municipio || '').padStart(2, '0') !== munQ) return false;
        if (parQ && String(r.codigo_parroquia || '').padStart(2, '0') !== parQ) return false;
        if (centroQ && !normalizarFiltroTexto(r.centro_votacion).includes(centroQ)) return false;
        if (comunidadQ && !normalizarFiltroTexto(r.comunidad).includes(comunidadQ)) return false;
        if (respComQ && !normalizarFiltroTexto(r.responsable_comunidad).includes(respComQ)) return false;
        if (enlaceQ && !normalizarFiltroTexto(r.enlace).includes(enlaceQ)) return false;
        if (respCalQ && !normalizarFiltroTexto(r.responsable_cal).includes(respCalQ)) return false;
        if (respLocQ && !normalizarFiltroTexto(r.responsable_local).includes(respLocQ)) return false;
        return true;
      })
      .sort((a, b) => String(a.codigo || '').localeCompare(String(b.codigo || '')));

    STATE.ultimoListado = resultados;
    $('listado-conteo').textContent = `${resultados.length} resultado(s)`;
    renderizarDirectorio();
  }

  async function cargarListado() {
    try {
      const res = await apiFetch('/api/activistas');
      const data = await res.json();
      STATE.todosActivistas = data.registros || [];
      renderizarChipsMunicipios();
      aplicarFiltrosEnMemoria();
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  }

  function setVistaDirectorio(modo) {
    STATE.vistaDirectorio = modo;
    const tablaWrap = $('contenedor-vista-tabla');
    const cardsWrap = $('contenedor-vista-cards');
    clearTimeout(tablaWrap._heightTimer);
    clearTimeout(cardsWrap._heightTimer);
    tablaWrap.style.height = '';
    tablaWrap.style.overflow = '';
    cardsWrap.style.height = '';
    cardsWrap.style.overflow = '';

    if (modo === 'tabla') {
      tablaWrap.classList.remove('hidden');
      cardsWrap.classList.add('hidden');
      $('view-mode-tabla').classList.add('bg-white', 'text-[#2563EB]', 'shadow-sm');
      $('view-mode-tabla').classList.remove('text-slate-600');
      $('view-mode-cards').classList.remove('bg-white', 'text-[#2563EB]', 'shadow-sm');
      $('view-mode-cards').classList.add('text-slate-600');
    } else {
      tablaWrap.classList.add('hidden');
      cardsWrap.classList.remove('hidden');
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
    const activeWrapper =
      STATE.vistaDirectorio === 'tabla' ? $('contenedor-vista-tabla') : cardsBox;
    const canAnimateHeight =
      activeWrapper &&
      !activeWrapper.classList.contains('hidden') &&
      activeWrapper.offsetHeight > 0;
    const prevHeight = canAnimateHeight ? activeWrapper.offsetHeight : 0;

    if (canAnimateHeight) {
      clearTimeout(activeWrapper._heightTimer);
      activeWrapper.style.height = `${prevHeight}px`;
      activeWrapper.style.overflow = 'hidden';
    }

    if (!regs.length) {
      tbody.innerHTML = `<tr class="dir-row-enter"><td colspan="8" class="px-4 py-16 text-center text-slate-500">No se encontraron activistas con los criterios aplicados.</td></tr>`;
      cardsBox.innerHTML = `<div class="dir-row-enter col-span-full bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">No se encontraron activistas con los criterios aplicados.</div>`;
    } else {
      tbody.innerHTML = regs
        .map((r, idx) => {
          const wa = normalizarWhatsApp(r.telefono);
          const telHtml = r.telefono
            ? `<div class="flex items-center gap-1.5 font-mono text-slate-700 whitespace-nowrap">
                 <span>${escapeHtml(r.telefono)}</span>
                 ${wa.length >= 10 ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer" class="no-print text-emerald-600 hover:text-emerald-700"><i data-lucide="message-circle" class="w-3.5 h-3.5"></i></a>` : ''}
               </div>`
            : '<span class="text-slate-400">-</span>';

          return `
            <tr class="dir-row-enter hover:bg-blue-50/30 transition-colors" style="animation-delay: ${Math.min(idx, 10) * 16}ms">
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
        .map((r, idx) => {
          const wa = normalizarWhatsApp(r.telefono);
          return `
            <div class="dir-row-enter bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col justify-between space-y-3" style="animation-delay: ${Math.min(idx, 10) * 18}ms">
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
    }

    if (canAnimateHeight) {
      activeWrapper.style.height = 'auto';
      const nextHeight = activeWrapper.offsetHeight;
      activeWrapper.style.height = `${prevHeight}px`;
      void activeWrapper.offsetHeight;
      activeWrapper.style.height = `${nextHeight}px`;
      activeWrapper._heightTimer = setTimeout(() => {
        activeWrapper.style.height = '';
        activeWrapper.style.overflow = '';
      }, 400);
    }

    if (!regs.length) return;

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

  $('btn-limpiar-filtros').addEventListener('click', () => {
    $('flt-cedula').value = '';
    $('flt-codigo').value = '';
    $('flt-municipio').value = '';
    poblarParroquiasSelect($('flt-parroquia'), '', '', 'Todas las Parroquias', true);
    $('flt-centro').value = '';
    $('flt-comunidad').value = '';
    $('flt-resp-comunidad').value = '';
    $('flt-enlace').value = '';
    $('flt-resp-cal').value = '';
    $('flt-resp-local').value = '';
    renderizarChipsMunicipios();
    aplicarFiltrosEnMemoria();
  });

  [
    'flt-cedula',
    'flt-codigo',
    'flt-centro',
    'flt-comunidad',
    'flt-resp-comunidad',
    'flt-enlace',
    'flt-resp-cal',
    'flt-resp-local',
  ].forEach((id) => {
    $(id).addEventListener('input', aplicarFiltrosEnMemoria);
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

    const redesList = parsearRedesSociales(r.redes_sociales || '');
    const redesHtml = redesList.length
      ? `<div class="flex flex-wrap gap-1.5 mt-1">${redesList
          .map((it) => {
            const url = construirUrlRedSocial(it.plataforma, it.usuario);
            const contenido = `${
              it.plataforma ? `<span class="text-slate-500">${escapeHtml(it.plataforma)}:</span>` : ''
            }<span>${escapeHtml(it.usuario)}</span>`;
            if (url) {
              return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Abrir perfil / contactar" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] border border-blue-200/80 text-[11px] font-semibold transition-colors">${contenido}<i data-lucide="external-link" class="w-3 h-3 shrink-0"></i></a>`;
            }
            return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 text-[11px] font-semibold">${contenido}</span>`;
          })
          .join('')}</div>`
      : '<p class="text-xs font-semibold text-slate-800 mt-0.5">-</p>';

    const campos = [
      ['Nombre y Apellido', r.nombre_apellido],
      ['Sexo', r.sexo || '-'],
      ['Teléfono', r.telefono || '-'],
      ['Correo', r.correo || '-'],
      ['Dirección de Habitación', r.direccion || '-'],
      ['Redes Sociales', null, redesHtml],
      ['Municipio', `${r.codigo_municipio} - ${r.municipio}`],
      ['Parroquia', `${r.codigo_parroquia} - ${r.parroquia}`],
      ['Centro de Votación', r.centro_votacion || '-'],
      ['Comunidad / Sector', r.comunidad || '-'],
      ['Comité Activismo Local (CAL)', r.comite_activismo_local || '-'],
      ['Dirección del CAL', r.direccion_cal || '-'],
      ['Responsable de CAL', r.responsable_cal || '-'],
      ['Responsable Local', r.responsable_local || '-'],
      ['Responsable de Comunidad', r.responsable_comunidad || '-'],
      ['Responsable Municipal', r.responsable_municipal || '-'],
      ['Enlace', r.enlace || '-'],
    ];
    $('drawer-view-mode').innerHTML = campos
      .map(
        ([lbl, val, customHtml]) => `
        <div class="bg-[#F8FAFC] border border-slate-200/80 rounded-xl p-3">
          <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(lbl)}</p>
          ${customHtml || `<p class="text-xs font-semibold text-slate-800 mt-0.5 break-words">${escapeHtml(val)}</p>`}
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
    $('drw-direccion').value = r.direccion || '';
    cargarRedesEnContenedor($('drw-redes-list'), r.redes_sociales || '', true);
    $('drw-comunidad').value = r.comunidad || '';
    $('drw-cal').value = r.comite_activismo_local || '';
    $('drw-direccion-cal').value = r.direccion_cal || '';
    $('drw-resp-cal').value = r.responsable_cal || '';
    $('drw-resp-local').value = r.responsable_local || '';
    $('drw-resp-comunidad').value = r.responsable_comunidad || '';
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
      direccion: $('drw-direccion').value,
      redes_sociales: serializarRedesSociales($('drw-redes-list')),
      comunidad: $('drw-comunidad').value,
      comite_activismo_local: $('drw-cal').value,
      direccion_cal: $('drw-direccion-cal').value,
      responsable_cal: $('drw-resp-cal').value,
      responsable_local: $('drw-resp-local').value,
      responsable_comunidad: $('drw-resp-comunidad').value,
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
      await Promise.all([cargarListado(), refrescarKPIs(), cargarEstructura()]);
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

  let RPT_LOGO_DATA_URL = '';
  try {
    RPT_LOGO_DATA_URL = localStorage.getItem('ap_rpt_logo') || '';
    const savedDest = localStorage.getItem('ap_rpt_nombre') || '';
    if (savedDest && $('rpt-destinatario-nombre')) {
      $('rpt-destinatario-nombre').value = savedDest;
    }
  } catch (_) {}

  function actualizarUIPersonalizacionReporte(expandirSiTieneDatos = false) {
    const nombre = ($('rpt-destinatario-nombre')?.value || '').trim();
    const tieneLogo = Boolean(RPT_LOGO_DATA_URL);
    const tieneDatos = Boolean(nombre || tieneLogo);

    if (tieneLogo) {
      $('rpt-logo-preview').src = RPT_LOGO_DATA_URL;
      $('rpt-logo-preview-wrap').classList.remove('hidden');
      $('rpt-logo-preview-wrap').classList.add('flex');
      $('rpt-logo-empty-hint').classList.add('hidden');
    } else {
      $('rpt-logo-preview').src = '';
      $('rpt-logo-preview-wrap').classList.add('hidden');
      $('rpt-logo-preview-wrap').classList.remove('flex');
      $('rpt-logo-empty-hint').classList.remove('hidden');
    }

    $('btn-limpiar-personalizar-rpt').classList.toggle('hidden', !tieneDatos);
    if (expandirSiTieneDatos && tieneDatos) {
      $('rpt-personalizar-panel').classList.remove('hidden');
    }
    const abierto = !$('rpt-personalizar-panel').classList.contains('hidden');
    $('btn-toggle-personalizar-text').textContent = abierto
      ? 'Ocultar personalización'
      : 'Personalizar destinatario / institución (opcional)';
  }

  function prepararMembreteImpresion() {
    const params = obtenerQueryFiltros();
    const partes = [];
    for (const [k, v] of params.entries()) partes.push(`${k}: ${v}`);
    const resumenFiltros =
      partes.length > 0 ? `Filtros aplicados: ${partes.join(' | ')}` : 'Listado General (Estado Aragua)';

    $('print-fecha').textContent = `Fecha: ${new Date().toLocaleString('es-VE')}`;
    $('print-total').textContent = `Total de registros: ${STATE.ultimoListado.length}`;
    $('print-filtros-resumen').textContent = resumenFiltros;

    const nombreDest = ($('rpt-destinatario-nombre')?.value || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const boxDest = $('print-destinatario-box');
    const imgDest = $('print-destinatario-logo');
    const txtDest = $('print-destinatario-nombre');

    if (nombreDest || RPT_LOGO_DATA_URL) {
      boxDest.classList.remove('hidden');
      txtDest.textContent = nombreDest || 'INSTITUCIÓN DESTINATARIA';
      if (RPT_LOGO_DATA_URL) {
        imgDest.src = RPT_LOGO_DATA_URL;
        imgDest.classList.remove('hidden');
      } else {
        imgDest.src = '';
        imgDest.classList.add('hidden');
      }
    } else {
      boxDest.classList.add('hidden');
      txtDest.textContent = '';
      imgDest.src = '';
      imgDest.classList.add('hidden');
    }

    try {
      if (nombreDest) localStorage.setItem('ap_rpt_nombre', nombreDest);
      else localStorage.removeItem('ap_rpt_nombre');
      if (RPT_LOGO_DATA_URL) localStorage.setItem('ap_rpt_logo', RPT_LOGO_DATA_URL);
      else localStorage.removeItem('ap_rpt_logo');
    } catch (_) {}

    return resumenFiltros;
  }

  function abrirModalReporte() {
    const params = obtenerQueryFiltros();
    const partes = [];
    for (const [k, v] of params.entries()) partes.push(`${k}: ${v}`);
    $('rpt-conteo-badge').textContent = `${STATE.ultimoListado.length} registro(s)`;
    $('rpt-filtros-badge').textContent =
      partes.length > 0 ? partes.join(' • ') : 'Listado General (Estado Aragua)';

    const tieneDatos = Boolean(
      ($('rpt-destinatario-nombre')?.value || '').trim() || RPT_LOGO_DATA_URL
    );
    if (!tieneDatos) {
      $('rpt-personalizar-panel').classList.add('hidden');
    }
    actualizarUIPersonalizacionReporte(true);

    $('reporte-modal').classList.remove('hidden');
    retriggerAnim($('reporte-modal-card'), 'animate-toast-in');
  }

  function cerrarModalReporte() {
    $('reporte-modal').classList.add('hidden');
  }

  $('btn-imprimir').addEventListener('click', abrirModalReporte);
  $('btn-cerrar-modal-reporte').addEventListener('click', cerrarModalReporte);
  $('btn-cancelar-modal-reporte').addEventListener('click', cerrarModalReporte);
  $('reporte-modal-backdrop').addEventListener('click', cerrarModalReporte);

  $('btn-toggle-personalizar-rpt').addEventListener('click', () => {
    $('rpt-personalizar-panel').classList.toggle('hidden');
    actualizarUIPersonalizacionReporte(false);
    if (!$('rpt-personalizar-panel').classList.contains('hidden')) {
      setTimeout(() => $('rpt-destinatario-nombre').focus(), 40);
    }
  });

  $('rpt-destinatario-nombre').addEventListener('input', () => {
    actualizarUIPersonalizacionReporte(false);
  });

  $('rpt-destinatario-logo-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      mostrarToast('Seleccione un archivo de imagen válido (PNG, JPG, SVG).', 'error');
      e.target.value = '';
      return;
    }
    if (file.size > 1500 * 1024) {
      mostrarToast('El logo debe pesar menos de 1.5 MB.', 'error');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      RPT_LOGO_DATA_URL = String(reader.result || '');
      actualizarUIPersonalizacionReporte(false);
    };
    reader.readAsDataURL(file);
  });

  $('btn-quitar-logo-rpt').addEventListener('click', () => {
    RPT_LOGO_DATA_URL = '';
    $('rpt-destinatario-logo-input').value = '';
    actualizarUIPersonalizacionReporte(false);
  });

  $('btn-limpiar-personalizar-rpt').addEventListener('click', () => {
    $('rpt-destinatario-nombre').value = '';
    RPT_LOGO_DATA_URL = '';
    $('rpt-destinatario-logo-input').value = '';
    try {
      localStorage.removeItem('ap_rpt_nombre');
      localStorage.removeItem('ap_rpt_logo');
    } catch (_) {}
    $('rpt-personalizar-panel').classList.add('hidden');
    actualizarUIPersonalizacionReporte(false);
  });

  $('btn-confirmar-imprimir').addEventListener('click', () => {
    prepararMembreteImpresion();
    cerrarModalReporte();
    setTimeout(() => window.print(), 60);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('reporte-modal').classList.contains('hidden')) {
      cerrarModalReporte();
    }
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

  // =========================================================
  // 6. VISTA 4: ESTRUCTURA Y RESPONSABLES + MODAL + COMBOBOX ESCRIBIBLE
  // =========================================================
  const ESTRUCTURA_ROLES = {
    enlace: {
      label: 'Enlace (quien entrega)',
      corto: 'Enlace',
      badge: 'bg-blue-50 text-[#2563EB] border-blue-200',
      campoActivista: 'enlace',
    },
    responsable_local: {
      label: 'Responsable Local',
      corto: 'Resp. Local',
      badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      campoActivista: 'responsable_local',
    },
    responsable_comunidad: {
      label: 'Responsable de Comunidad',
      corto: 'Resp. Comunidad',
      badge: 'bg-amber-50 text-amber-700 border-amber-200',
      campoActivista: 'responsable_comunidad',
    },
    responsable_municipal: {
      label: 'Responsable Municipal',
      corto: 'Resp. Municipal',
      badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      campoActivista: 'responsable_municipal',
    },
    responsable_cal: {
      label: 'Responsable de CAL',
      corto: 'Resp. CAL',
      badge: 'bg-violet-50 text-violet-700 border-violet-200',
      campoActivista: 'responsable_cal',
    },
  };

  const PENDING_ESTRUCTURA_SAVES = new Set();
  const COMBOBOX_REFRESHERS = [];

  function normalizarNombreEstructura(val) {
    return String(val || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function existeEnEstructura(rol, nombre) {
    const norm = normalizarNombreEstructura(nombre);
    if (!norm) return false;
    return STATE.estructura.some((it) => it.rol === rol && it.nombre === norm);
  }

  function refrescarComboboxesEstructura() {
    COMBOBOX_REFRESHERS.forEach((fn) => fn());
  }

  async function cargarEstructura() {
    try {
      const res = await apiFetch('/api/estructura');
      const data = await res.json();
      STATE.estructura = data.registros || [];
      renderizarEstructura();
      refrescarComboboxesEstructura();
    } catch (_) {}
  }

  async function guardarEstructuraAuto(rol, rawNombre, { codigoMunicipio = '', silent = false } = {}) {
    const nombre = normalizarNombreEstructura(rawNombre);
    if (!STATE.token || !ESTRUCTURA_ROLES[rol] || nombre.length < 2) return null;
    if (existeEnEstructura(rol, nombre)) return null;

    const key = `${rol}|${nombre}`;
    if (PENDING_ESTRUCTURA_SAVES.has(key)) return null;
    PENDING_ESTRUCTURA_SAVES.add(key);

    try {
      const res = await apiFetch('/api/estructura', {
        method: 'POST',
        body: JSON.stringify({
          rol,
          nombre,
          codigo_municipio: codigoMunicipio || '',
        }),
      });
      const data = await res.json();
      if (data.item) {
        const idx = STATE.estructura.findIndex((x) => x.id === data.item.id);
        if (idx >= 0) STATE.estructura[idx] = data.item;
        else STATE.estructura.push(data.item);
        STATE.estructura.sort((a, b) =>
          (a.rol + '|' + a.nombre).localeCompare(b.rol + '|' + b.nombre)
        );
        renderizarEstructura();
        refrescarComboboxesEstructura();
        if (!silent && data.creado) {
          mostrarToast(
            `${data.item.nombre} guardado automáticamente en ${ESTRUCTURA_ROLES[rol].label}.`,
            'ok'
          );
        }
      }
      return data.item || null;
    } catch (_) {
      return null;
    } finally {
      PENDING_ESTRUCTURA_SAVES.delete(key);
    }
  }

  function crearComboboxEstructura(inputEl, rol, getMunCode = () => '') {
    if (!inputEl || inputEl.dataset.comboboxReady) return;
    inputEl.dataset.comboboxReady = '1';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.classList.add('pr-8');

    const wrapper = document.createElement('div');
    wrapper.className = 'relative w-full';
    inputEl.parentNode.insertBefore(wrapper, inputEl);
    wrapper.appendChild(inputEl);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.tabIndex = -1;
    toggleBtn.setAttribute('aria-label', `Ver opciones de ${ESTRUCTURA_ROLES[rol]?.label || rol}`);
    toggleBtn.className =
      'cursor-pointer absolute inset-y-0 right-0 px-2.5 flex items-center text-slate-400 hover:text-[#2563EB] transition-colors';
    toggleBtn.innerHTML =
      '<svg class="w-4 h-4 transition-transform duration-150" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>';
    wrapper.appendChild(toggleBtn);

    const menu = document.createElement('div');
    menu.className =
      'hidden absolute left-0 right-0 top-full mt-1 z-40 bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-y-auto py-1';
    wrapper.appendChild(menu);

    let isOpen = false;
    let activeIdx = -1;
    let ignoreBlurSave = false;

    const getOpciones = (mostrarTodas = false) => {
      const q = normalizarNombreEstructura(inputEl.value);
      const delRol = STATE.estructura.filter((it) => it.rol === rol);
      if (mostrarTodas || !q) return delRol;
      return delRol.filter((it) => it.nombre.includes(q));
    };

    const posicionarMenu = () => {
      const rect = inputEl.getBoundingClientRect();
      const espacioAbajo = window.innerHeight - rect.bottom;
      if (espacioAbajo < 220 && rect.top > 220) {
        menu.classList.remove('top-full', 'mt-1');
        menu.classList.add('bottom-full', 'mb-1');
      } else {
        menu.classList.remove('bottom-full', 'mb-1');
        menu.classList.add('top-full', 'mt-1');
      }
    };

    const renderMenu = (mostrarTodas = false) => {
      const opciones = getOpciones(mostrarTodas);
      const q = normalizarNombreEstructura(inputEl.value);
      const yaExiste = existeEnEstructura(rol, q);
      const puedeCrear = q.length >= 2 && !yaExiste;

      const itemsHtml = opciones
        .map((it, idx) => {
          const meta = [it.municipio, it.telefono].filter(Boolean).join(' • ');
          const selected = it.nombre === q;
          return `
            <button
              type="button"
              data-combo-val="${escapeHtml(it.nombre)}"
              data-combo-idx="${idx}"
              class="combo-opt w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 transition-colors ${
                idx === activeIdx
                  ? 'bg-blue-50 text-[#2563EB]'
                  : selected
                  ? 'bg-slate-50 text-[#2563EB] font-semibold'
                  : 'text-slate-700 hover:bg-slate-50'
              }"
            >
              <span class="font-semibold truncate">${escapeHtml(it.nombre)}</span>
              ${meta ? `<span class="text-[10px] text-slate-400 shrink-0">${escapeHtml(meta)}</span>` : ''}
            </button>`;
        })
        .join('');

      const createHtml = puedeCrear
        ? `
          <button
            type="button"
            data-combo-create="${escapeHtml(q)}"
            data-combo-idx="${opciones.length}"
            class="combo-opt w-full text-left px-3 py-2 text-xs flex items-center gap-1.5 border-t border-slate-100 text-[#2563EB] font-semibold ${
              activeIdx === opciones.length ? 'bg-blue-50' : 'bg-blue-50/40 hover:bg-blue-50'
            }"
          >
            <span>+ Guardar “${escapeHtml(q)}” en estructura</span>
          </button>`
        : '';

      if (!itemsHtml && !createHtml) {
        menu.innerHTML =
          '<p class="px-3 py-2.5 text-[11px] text-slate-400 text-center">Sin registros aún. Escriba un nombre para guardarlo automáticamente.</p>';
      } else {
        menu.innerHTML = itemsHtml + createHtml;
      }

      menu.querySelectorAll('.combo-opt').forEach((btn) => {
        btn.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          ignoreBlurSave = true;
          const createVal = btn.dataset.comboCreate;
          const val = createVal || btn.dataset.comboVal || '';
          inputEl.value = val;
          cerrar();
          if (createVal) {
            await guardarEstructuraAuto(rol, createVal, { codigoMunicipio: getMunCode() });
          }
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    };

    const abrir = (mostrarTodas = false) => {
      posicionarMenu();
      activeIdx = -1;
      renderMenu(mostrarTodas);
      menu.classList.remove('hidden');
      isOpen = true;
      toggleBtn.querySelector('svg').classList.add('rotate-180');
    };

    const cerrar = () => {
      menu.classList.add('hidden');
      isOpen = false;
      activeIdx = -1;
      toggleBtn.querySelector('svg').classList.remove('rotate-180');
    };

    toggleBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (isOpen) {
        cerrar();
      } else {
        inputEl.focus();
        abrir(true);
      }
    });

    inputEl.addEventListener('focus', () => abrir(true));
    inputEl.addEventListener('input', () => abrir(false));

    inputEl.addEventListener('keydown', async (e) => {
      if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        abrir(true);
        return;
      }
      const btns = Array.from(menu.querySelectorAll('.combo-opt'));
      if (e.key === 'ArrowDown' && btns.length) {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % btns.length;
        renderMenu(false);
      } else if (e.key === 'ArrowUp' && btns.length) {
        e.preventDefault();
        activeIdx = (activeIdx - 1 + btns.length) % btns.length;
        renderMenu(false);
      } else if (e.key === 'Enter') {
        if (isOpen && activeIdx >= 0 && btns[activeIdx]) {
          e.preventDefault();
          btns[activeIdx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        } else if (normalizarNombreEstructura(inputEl.value).length >= 2) {
          e.preventDefault();
          const norm = normalizarNombreEstructura(inputEl.value);
          inputEl.value = norm;
          cerrar();
          await guardarEstructuraAuto(rol, norm, { codigoMunicipio: getMunCode() });
        }
      } else if (e.key === 'Escape') {
        cerrar();
      }
    });

    inputEl.addEventListener('blur', () => {
      setTimeout(async () => {
        cerrar();
        if (ignoreBlurSave) {
          ignoreBlurSave = false;
          return;
        }
        const norm = normalizarNombreEstructura(inputEl.value);
        if (norm.length >= 2) {
          inputEl.value = norm;
          if (!existeEnEstructura(rol, norm)) {
            await guardarEstructuraAuto(rol, norm, { codigoMunicipio: getMunCode() });
          }
        }
      }, 130);
    });

    COMBOBOX_REFRESHERS.push(() => {
      if (isOpen) renderMenu(false);
    });
  }

  [
    ['grp-enlace', 'enlace', () => $('grp-municipio').value],
    ['grp-resp-local', 'responsable_local', () => $('grp-municipio').value],
    ['grp-resp-comunidad', 'responsable_comunidad', () => $('grp-municipio').value],
    ['grp-resp-municipal', 'responsable_municipal', () => $('grp-municipio').value],
    ['grp-resp-cal', 'responsable_cal', () => $('grp-municipio').value],
    ['form-enlace', 'enlace', () => $('form-municipio').value],
    ['form-resp-local', 'responsable_local', () => $('form-municipio').value],
    ['form-resp-comunidad', 'responsable_comunidad', () => $('form-municipio').value],
    ['form-resp-municipal', 'responsable_municipal', () => $('form-municipio').value],
    ['form-resp-cal', 'responsable_cal', () => $('form-municipio').value],
    ['drw-enlace', 'enlace', () => $('drw-municipio').value],
    ['drw-resp-local', 'responsable_local', () => $('drw-municipio').value],
    ['drw-resp-comunidad', 'responsable_comunidad', () => $('drw-municipio').value],
    ['drw-resp-municipal', 'responsable_municipal', () => $('drw-municipio').value],
    ['drw-resp-cal', 'responsable_cal', () => $('drw-municipio').value],
  ].forEach(([id, rol, getMun]) => crearComboboxEstructura($(id), rol, getMun));

  function abrirModalEstructura(item = null) {
    const modal = $('estructura-modal');
    const card = $('estructura-modal-card');
    if (!modal) return;
    $('estructura-form').reset();

    if (item) {
      $('est-modal-title').textContent = 'Editar Responsable de Estructura';
      $('btn-guardar-estructura-text').textContent = 'Guardar Cambios';
      $('est-rol').value = item.rol;
      $('est-nombre').value = item.nombre;
      $('est-cedula').value = item.cedula || '';
      $('est-telefono').value = item.telefono || '';
      $('est-municipio').value = item.codigo_municipio || '';
    } else {
      $('est-modal-title').textContent = 'Registrar en Estructura y Responsables';
      $('btn-guardar-estructura-text').textContent = 'Guardar en Estructura';
      if (STATE.estRolFiltro && ESTRUCTURA_ROLES[STATE.estRolFiltro]) {
        $('est-rol').value = STATE.estRolFiltro;
      }
    }

    modal.classList.remove('hidden');
    retriggerAnim(card, 'animate-toast-in');
    setTimeout(() => $('est-nombre').focus(), 40);
  }

  function cerrarModalEstructura() {
    const modal = $('estructura-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    $('estructura-form').reset();
  }

  function renderizarEstructura() {
    const chipsBox = $('est-role-chips');
    const tbody = $('tabla-estructura-body');
    const resumenEl = $('estructura-resumen');
    if (!chipsBox || !tbody) return;

    const conteosRol = {};
    for (const rol of Object.keys(ESTRUCTURA_ROLES)) conteosRol[rol] = 0;
    for (const it of STATE.estructura) {
      if (conteosRol[it.rol] !== undefined) conteosRol[it.rol] += 1;
    }

    const chips = [
      { rol: '', label: `Todos (${STATE.estructura.length})` },
      ...Object.entries(ESTRUCTURA_ROLES).map(([rol, meta]) => ({
        rol,
        label: `${meta.corto} (${conteosRol[rol] || 0})`,
      })),
    ];

    chipsBox.innerHTML = chips
      .map((c) => {
        const active = STATE.estRolFiltro === c.rol;
        return `
          <button
            type="button"
            data-est-rol="${escapeHtml(c.rol)}"
            class="est-rol-chip cursor-pointer px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              active
                ? 'bg-[#2563EB] text-white border-[#2563EB]'
                : 'bg-[#F8FAFC] text-slate-600 border-slate-200 hover:bg-slate-100'
            }"
          >
            ${escapeHtml(c.label)}
          </button>`;
      })
      .join('');

    chipsBox.querySelectorAll('.est-rol-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        STATE.estRolFiltro = btn.dataset.estRol || '';
        renderizarEstructura();
      });
    });

    const q = normalizarNombreEstructura($('est-buscar')?.value || '');
    const filtrados = STATE.estructura.filter((it) => {
      if (STATE.estRolFiltro && it.rol !== STATE.estRolFiltro) return false;
      if (q) {
        const hay = `${it.nombre} ${it.municipio || ''} ${it.cedula || ''}`.toUpperCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (resumenEl) {
      resumenEl.textContent = `${filtrados.length} de ${STATE.estructura.length} responsables registrados en estructura.`;
    }

    if (!filtrados.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-500">No hay responsables registrados para este criterio.</td></tr>';
      return;
    }

    const conteoPorRolNombre = new Map();
    for (const act of STATE.todosActivistas) {
      for (const [rol, meta] of Object.entries(ESTRUCTURA_ROLES)) {
        const val = normalizarNombreEstructura(act[meta.campoActivista]);
        if (val) {
          const k = `${rol}|${val}`;
          conteoPorRolNombre.set(k, (conteoPorRolNombre.get(k) || 0) + 1);
        }
      }
    }

    tbody.innerHTML = filtrados
      .map((it) => {
        const meta = ESTRUCTURA_ROLES[it.rol] || {
          label: it.rol,
          badge: 'bg-slate-100 text-slate-700 border-slate-200',
        };
        const vinculos = conteoPorRolNombre.get(`${it.rol}|${it.nombre}`) || 0;
        const contacto = [it.cedula ? `V-${it.cedula}` : '', it.telefono || '']
          .filter(Boolean)
          .join(' • ');
        return `
          <tr class="hover:bg-slate-50/80">
            <td class="px-4 py-3 font-semibold text-slate-800">${escapeHtml(it.nombre)}</td>
            <td class="px-4 py-3">
              <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${meta.badge}">
                ${escapeHtml(meta.label)}
              </span>
            </td>
            <td class="px-4 py-3 text-slate-600">${escapeHtml(it.municipio || '—')}</td>
            <td class="px-4 py-3 font-mono text-slate-600">${escapeHtml(contacto || '—')}</td>
            <td class="px-4 py-3 text-center">
              <span class="font-mono font-semibold text-[#2563EB]">${vinculos}</span>
            </td>
            <td class="px-4 py-3 text-right">
              <div class="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  data-est-edit="${escapeHtml(it.id)}"
                  class="est-btn-edit cursor-pointer px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] font-semibold text-[11px] transition-colors"
                >
                  Editar
                </button>
                <button
                  type="button"
                  data-est-del="${escapeHtml(it.id)}"
                  class="est-btn-del cursor-pointer px-2.5 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold text-[11px] transition-colors"
                >
                  Eliminar
                </button>
              </div>
            </td>
          </tr>`;
      })
      .join('');

    tbody.querySelectorAll('.est-btn-edit').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = STATE.estructura.find((x) => x.id === btn.dataset.estEdit);
        if (item) abrirModalEstructura(item);
      });
    });

    tbody.querySelectorAll('.est-btn-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = STATE.estructura.find((x) => x.id === btn.dataset.estDel);
        if (!item) return;
        if (!confirm(`¿Eliminar a ${item.nombre} del catálogo de Estructura y Responsables?`)) return;
        try {
          await apiFetch(`/api/estructura/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          STATE.estructura = STATE.estructura.filter((x) => x.id !== item.id);
          renderizarEstructura();
          refrescarComboboxesEstructura();
          mostrarToast(`${item.nombre} eliminado de estructura.`, 'ok');
        } catch (err) {
          mostrarToast(err.message, 'error');
        }
      });
    });
  }

  $('btn-abrir-modal-estructura').addEventListener('click', () => abrirModalEstructura(null));
  $('btn-cerrar-modal-estructura').addEventListener('click', cerrarModalEstructura);
  $('btn-cancelar-modal-estructura').addEventListener('click', cerrarModalEstructura);
  $('estructura-modal-backdrop').addEventListener('click', cerrarModalEstructura);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('estructura-modal').classList.contains('hidden')) {
      cerrarModalEstructura();
    }
  });

  $('est-buscar').addEventListener('input', renderizarEstructura);

  $('estructura-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      rol: $('est-rol').value,
      nombre: $('est-nombre').value,
      cedula: $('est-cedula').value,
      telefono: $('est-telefono').value,
      codigo_municipio: $('est-municipio').value,
    };
    try {
      const res = await apiFetch('/api/estructura', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.item) {
        const idx = STATE.estructura.findIndex((x) => x.id === data.item.id);
        if (idx >= 0) STATE.estructura[idx] = data.item;
        else STATE.estructura.push(data.item);
        STATE.estructura.sort((a, b) =>
          (a.rol + '|' + a.nombre).localeCompare(b.rol + '|' + b.nombre)
        );
      }
      cerrarModalEstructura();
      renderizarEstructura();
      refrescarComboboxesEstructura();
      mostrarToast(
        `${data.item.nombre} ${data.creado ? 'registrado' : 'actualizado'} en Estructura y Responsables.`,
        'ok'
      );
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  });

  refreshIcons();
  if (STATE.token) {
    inicializarSesion().catch(() => cerrarSesionLocal());
  }
})();

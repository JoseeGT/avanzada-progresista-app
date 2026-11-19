import { renderizarAnalitica, initAnalitica } from './analitica.js';
import { apiFetch, cargarCentrosCne, mostrarToast } from './api.js';
import {
  cargarConfigAuth,
  initAuth,
  intentarReanudarSesion,
  mostrarApp,
} from './auth.js';
import { initBackup } from './backup.js';
import { refrescarComboboxes } from './combobox.js';
import {
  abrirDrawerPorCedula,
  abrirModalReporte,
  aplicarFiltrosEnMemoria,
  cargarListado,
  initDirectorio,
  limpiarFiltrosDirectorioSoloInputs,
  renderizarChipsMunicipios,
} from './directorio.js';
import { cargarEstructura, initEstructura } from './estructura.js';
import {
  actualizarCodigoSiguiente,
  actualizarCodigoSiguienteGrupal,
  actualizarPillModoCarga,
  buscarCedulaCNE,
  hayDatosEnPlanillaGrupal,
  initRegistro,
  limpiarFormulario,
  limpiarPlanillaGrupal,
  restaurarBorradorPlanilla,
  setRegistroModo,
} from './registro.js';
import {
  $,
  STATE,
  animarNumeroKPI,
  escapeHtml,
  poblarParroquiasSelect,
  refreshIcons,
  removerActivistaEnMemoria,
  retriggerAnim,
} from './state.js';

const VIEW_TITLES = {
  registro: 'Recepción y Registro',
  listados: 'Directorio de Activistas',
  estructura: 'Estructura y Responsables',
  estadisticas: 'Reportes y Analítica (%)',
};

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

async function cargarEstadoSistema() {
  try {
    const res = await apiFetch('/api/estado-sistema');
    const data = await res.json();
    $('sidebar-db-status').textContent =
      data.modo_persistencia === 'firestore' ? 'Firestore' : 'JSON Local';
    $('sidebar-cne-status').textContent = data.padron_disponible
      ? 'Online'
      : 'Inactivo';
  } catch (_) {}
}

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
    { el: $('cne-nombre-mun'), placeholder: 'Todos los Municipios' },
    { el: $('imp-municipio'), placeholder: 'Según archivo / respaldo...' },
  ];

  for (const cfg of selectsMun) {
    if (!cfg.el) continue;
    cfg.el.innerHTML = `<option value="">${escapeHtml(cfg.placeholder)}</option>`;
    for (const m of STATE.catalogo) {
      cfg.el.insertAdjacentHTML(
        'beforeend',
        `<option value="${escapeHtml(m.codigo)}">${escapeHtml(m.codigo)} - ${escapeHtml(m.nombre)}</option>`
      );
    }
  }

  poblarParroquiasSelect(
    $('flt-parroquia'),
    '',
    '',
    'Todas las Parroquias',
    true
  );
  poblarParroquiasSelect(
    $('stats-flt-parroquia'),
    '',
    '',
    'Todas las Parroquias',
    false
  );
  renderizarChipsMunicipios();
  await actualizarCodigoSiguienteGrupal('01');
}

function recalcularKPIsDesdeMemoria() {
  const regs = STATE.todosActivistas;
  const total = regs.length;
  const municipiosSet = new Set(
    regs.map((r) => r.codigo_municipio).filter(Boolean)
  );
  const calsSet = new Set(
    regs
      .map((r) => String(r.comite_activismo_local || '').trim())
      .filter(Boolean)
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
  refrescarComboboxes();
}

async function recargarTodosActivistas() {
  try {
    const res = await apiFetch('/api/activistas');
    const data = await res.json();
    STATE.todosActivistas = data.registros || [];
    STATE.activistasCargados = true;
    recalcularKPIsDesdeMemoria();
    if (!$('tab-listados').classList.contains('hidden')) {
      aplicarFiltrosEnMemoria(false);
    }
    if (!$('tab-estadisticas').classList.contains('hidden')) {
      renderizarAnalitica();
    }
  } catch (_) {}
}

function activarTab(tabName) {
  ['registro', 'listados', 'estructura', 'estadisticas'].forEach((t) => {
    const sec = $(`tab-${t}`);
    if (!sec) return;
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
      btn.classList.add(
        'bg-blue-600/15',
        'text-white',
        'border-blue-500/30',
        'font-semibold'
      );
      btn.classList.remove(
        'text-slate-300',
        'hover:bg-slate-800/70',
        'hover:text-white',
        'border-transparent',
        'font-medium'
      );
      if (icon) icon.classList.add('text-blue-400');
    } else {
      btn.classList.remove(
        'bg-blue-600/15',
        'text-white',
        'border-blue-500/30',
        'font-semibold'
      );
      btn.classList.add(
        'text-slate-300',
        'hover:bg-slate-800/70',
        'hover:text-white',
        'border-transparent',
        'font-medium'
      );
      if (icon) icon.classList.remove('text-blue-400');
    }
  });

  $('topbar-view-title').textContent = VIEW_TITLES[tabName] || 'Panel Electoral';
  toggleSidebarMobile(false);

  if (tabName === 'registro') {
    requestAnimationFrame(() => actualizarPillModoCarga(false));
  } else if (tabName === 'listados') {
    if (!STATE.activistasCargados) {
      cargarListado();
    } else {
      renderizarChipsMunicipios();
      aplicarFiltrosEnMemoria(false);
    }
  } else if (tabName === 'estructura') {
    cargarEstructura();
  } else if (tabName === 'estadisticas') {
    renderizarAnalitica();
  }
}

async function inicializarSesion() {
  mostrarApp();
  const rolInicial = STATE.user?.rol || 'admin';
  activarTab(rolInicial === 'consulta' ? 'listados' : 'registro');

  await Promise.allSettled([
    cargarCatalogo(),
    cargarEstadoSistema(),
    recargarTodosActivistas(),
    cargarEstructura(),
    cargarCentrosCne(),
  ]);
  await actualizarCodigoSiguiente($('form-municipio').value || '01').catch(
    () => {}
  );
  if (rolInicial !== 'consulta') {
    restaurarBorradorPlanilla();
  }
}

function bootstrap() {
  STATE.callbacks.onLoginSuccess = inicializarSesion;
  STATE.callbacks.onShowApp = () => {
    requestAnimationFrame(() => actualizarPillModoCarga(false));
  };
  STATE.callbacks.onDataChanged = async ({ reloadEstructura = false } = {}) => {
    recalcularKPIsDesdeMemoria();
    if (reloadEstructura) {
      await cargarEstructura();
    }
    if (!$('tab-listados').classList.contains('hidden')) {
      aplicarFiltrosEnMemoria(false);
    }
    if (!$('tab-estadisticas').classList.contains('hidden')) {
      renderizarAnalitica();
    }
  };
  STATE.callbacks.onActivistaEliminado = async (cedula) => {
    removerActivistaEnMemoria(cedula);
    recalcularKPIsDesdeMemoria();
    if (!$('tab-listados').classList.contains('hidden')) {
      aplicarFiltrosEnMemoria(false);
    }
  };
  STATE.callbacks.onFullReloadActivistas = recargarTodosActivistas;
  STATE.callbacks.onRestoreComplete = async () => {
    await Promise.all([
      cargarEstadoSistema(),
      recargarTodosActivistas(),
      cargarEstructura(),
    ]);
    if (!$('tab-listados').classList.contains('hidden')) {
      aplicarFiltrosEnMemoria(true);
    }
  };
  STATE.callbacks.onFiltrarDirectorioPorEstructura = (fltId, nombre) => {
    limpiarFiltrosDirectorioSoloInputs();
    if (fltId && $(fltId)) {
      $(fltId).value = nombre;
    }
    STATE.paginaDirectorio = 1;
    activarTab('listados');
  };
  STATE.callbacks.onOpenDrawerByCedula = abrirDrawerPorCedula;
  STATE.callbacks.onAbrirModalReporte = abrirModalReporte;

  $('btn-open-sidebar')?.addEventListener('click', () =>
    toggleSidebarMobile(true)
  );
  $('btn-close-sidebar')?.addEventListener('click', () =>
    toggleSidebarMobile(false)
  );
  $('sidebar-backdrop')?.addEventListener('click', () =>
    toggleSidebarMobile(false)
  );

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => activarTab(btn.dataset.tab));
  });

  $('btn-nuevo-registro-sidebar')?.addEventListener('click', () => {
    activarTab('registro');
    if (STATE.registroModo === 'grupal') {
      if (!hayDatosEnPlanillaGrupal()) {
        limpiarPlanillaGrupal(false);
      }
      $('grp-codigo')?.focus();
    } else {
      $('cne-cedula-search').value = '';
      limpiarFormulario();
      $('cne-cedula-search')?.focus();
    }
  });

  $('topbar-quick-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = $('topbar-quick-search').value.replace(/\D/g, '');
      if (q.length >= 5 && q.length <= 12) {
        setRegistroModo('individual');
        $('cne-cedula-search').value = q;
        activarTab('registro');
        buscarCedulaCNE();
      } else {
        mostrarToast('Ingrese entre 5 y 12 dígitos de cédula.', 'error');
      }
    }
  });

  initAuth();
  initRegistro();
  initDirectorio();
  initEstructura();
  initAnalitica();
  initBackup();

  refreshIcons();
  cargarConfigAuth();
  intentarReanudarSesion();
}

bootstrap();

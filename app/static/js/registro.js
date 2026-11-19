import {
  apiFetch,
  buscarPadronPorNombre,
  consultarElectorCached,
  mostrarToast,
  pedirConfirmacion,
  withButtonLoading,
} from './api.js';
import { crearCombobox } from './combobox.js';
import {
  $,
  BORRADOR_PLANILLA_KEY,
  REDES_PLATAFORMAS,
  STATE,
  armarCodigoPorRepresentante,
  calcularEdad,
  escapeHtml,
  normalizarInputCodigoPlanilla,
  obtenerIniciales,
  poblarParroquiasSelect,
  refreshIcons,
  retriggerAnim,
  upsertActivistaEnMemoria,
} from './state.js';

let _borradorTimer = null;
let _nombreSearchTarget = 'individual'; // 'individual' | 'grupal'
let _importPreviewData = null;

// =========================================================
// REDES SOCIALES (Compartido con Drawer)
// =========================================================
export function parsearRedesSociales(texto) {
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

export function construirUrlRedSocial(plataforma, usuario) {
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

export function crearFilaRedSocial(
  containerEl,
  plataforma = '',
  usuario = '',
  compact = false
) {
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

export function cargarRedesEnContenedor(containerEl, texto, compact = false) {
  if (!containerEl) return;
  containerEl.innerHTML = '';
  const items = parsearRedesSociales(texto);
  if (!items.length) {
    crearFilaRedSocial(containerEl, '', '', compact);
    return;
  }
  items.forEach((it) =>
    crearFilaRedSocial(containerEl, it.plataforma, it.usuario, compact)
  );
}

export function serializarRedesSociales(containerEl) {
  if (!containerEl) return '';
  const valores = [];
  containerEl.querySelectorAll('.red-social-row').forEach((row) => {
    const plat = row.querySelector('.red-plataforma').value.trim();
    const usr = row.querySelector('.red-usuario').value.trim();
    if (!usr) return;
    valores.push(plat ? `${plat}: ${usr}` : usr);
  });
  return valores.join(', ');
}

// =========================================================
// MODO DE CARGA (PILL + ANIMACIÓN)
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

export function actualizarPillModoCarga(animar = true) {
  const pill = $('modo-carga-pill');
  const btnActivo = $(
    STATE.registroModo === 'grupal' ? 'btn-modo-grupal' : 'btn-modo-individual'
  );
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

export function setRegistroModo(modo) {
  const prevModo = STATE.registroModo;
  STATE.registroModo = modo;
  const esGrupal = modo === 'grupal';
  const grupalEl = $('modo-planilla-grupal');
  const indivEl = $('modo-registro-individual');

  const btnGrupal = $('btn-modo-grupal');
  const btnIndiv = $('btn-modo-individual');
  btnGrupal.className = `${MODO_BTN_BASE} ${
    esGrupal ? 'text-[#2563EB]' : 'text-slate-600 hover:text-slate-900'
  }`;
  btnIndiv.className = `${MODO_BTN_BASE} ${
    !esGrupal ? 'text-[#2563EB]' : 'text-slate-600 hover:text-slate-900'
  }`;
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
  outgoing.classList.add(
    'pointer-events-none',
    'absolute',
    'top-0',
    'left-0',
    'right-0',
    'z-0'
  );
  retriggerAnim(
    outgoing,
    haciaDerecha ? 'animate-modo-exit-left' : 'animate-modo-exit-right'
  );
  outgoing._modoExitTimer = setTimeout(() => {
    outgoing.classList.add('hidden');
    limpiarEstadoAnimModo(outgoing);
  }, 210);

  incoming.classList.remove('hidden');
  incoming.classList.add('relative', 'z-10');
  retriggerAnim(
    incoming,
    haciaDerecha ? 'animate-modo-enter-right' : 'animate-modo-enter-left'
  );

  const descEl = $('registro-modo-desc');
  descEl.textContent = esGrupal
    ? 'Carga rápida por planilla física: llene la cabecera una vez y agregue la lista de personas.'
    : 'Consulta individual en Padrón CNE y edición de expediente de una sola persona.';
  retriggerAnim(descEl, 'animate-modo-desc');
}

// =========================================================
// CÓDIGOS DE PLANILLA Y FORMULARIO INDIVIDUAL
// =========================================================
export async function actualizarCodigoSiguiente(codMun) {
  if (STATE.modoEdicion || !codMun) return;
  const codRep = armarCodigoPorRepresentante(
    codMun,
    $('form-enlace')?.value,
    $('form-resp-cal')?.value
  );
  if (codRep) {
    $('form-codigo').value = codRep;
    return;
  }
  try {
    const res = await apiFetch(
      `/api/activistas/codigo-siguiente/${encodeURIComponent(codMun)}`
    );
    const data = await res.json();
    $('form-codigo').value = data.codigo;
  } catch (_) {}
}

export async function actualizarCodigoSiguienteGrupal(codMun, forzar = false) {
  if (!codMun) return;
  const actual = $('grp-codigo').value.trim();
  if (!forzar && actual && actual !== STATE.ultimoCodigoSugeridoGrupal) return;
  const codRep = armarCodigoPorRepresentante(
    codMun,
    $('grp-enlace')?.value,
    $('grp-resp-cal')?.value
  );
  if (codRep) {
    $('grp-codigo').value = codRep;
    STATE.ultimoCodigoSugeridoGrupal = codRep;
    return;
  }
  try {
    const res = await apiFetch(
      `/api/activistas/codigo-siguiente/${encodeURIComponent(codMun)}`
    );
    const data = await res.json();
    $('grp-codigo').value = data.codigo;
    STATE.ultimoCodigoSugeridoGrupal = data.codigo;
  } catch (_) {}
}

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

function actualizarBotonWhatsAppForm() {
  const wa = String($('form-telefono').value || '').replace(/\D/g, '');
  const btn = $('form-whatsapp-btn');
  if (!btn) return;
  let waNorm = wa;
  if (waNorm.startsWith('0')) waNorm = '58' + waNorm.slice(1);
  else if (waNorm && !waNorm.startsWith('58')) waNorm = '58' + waNorm;
  if (waNorm.length >= 10) {
    btn.href = `https://wa.me/${waNorm}`;
    btn.classList.remove('hidden');
    btn.classList.add('inline-flex');
  } else {
    btn.classList.add('hidden');
    btn.classList.remove('inline-flex');
  }
}

function actualizarTarjetaResumen(datos, estado) {
  const card = $('elector-summary-card');
  card.classList.remove('hidden');

  const nombre = datos.nombre_apellido || 'Sin nombre registrado';
  $('summary-avatar').textContent = obtenerIniciales(nombre);
  $('summary-nombre').textContent = nombre;
  $('summary-cedula').textContent = `C.I. ${
    datos.nacionalidad || $('cne-nacionalidad').value
  }-${datos.cedula || ''}`;
  $('summary-codigo').textContent =
    datos.codigo || $('form-codigo').value || 'AP-01-01';
  $('summary-municipio').textContent = datos.municipio || '-';
  $('summary-parroquia').textContent = datos.parroquia || '-';
  $('summary-centro').textContent =
    datos.centro_votacion || 'Sin centro asignado';

  const edad = calcularEdad(datos.fecha_nacimiento);
  const metaParts = [];
  if (datos.mesa) metaParts.push(`Mesa ${datos.mesa}`);
  if (edad !== null) metaParts.push(`${edad} años`);
  if (datos.cod_centro) metaParts.push(`Cód. ${datos.cod_centro}`);
  const metaEl = $('summary-meta-cne');
  if (metaEl) {
    metaEl.textContent = metaParts.join(' • ');
    metaEl.classList.toggle('hidden', metaParts.length === 0);
  }

  const badge = $('summary-badge');
  if (estado === 'activistas') {
    badge.className =
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200';
    badge.textContent = 'Activista Ya Registrado - Modo Edición';
  } else if (estado === 'padron') {
    badge.className =
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200';
    badge.textContent = 'Padrón CNE Verificado';
  } else {
    badge.className =
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white text-slate-600 border border-slate-200';
    badge.textContent = 'Registro Manual (No hallado en Padrón)';
  }
}

export function limpiarFormulario() {
  STATE.modoEdicion = false;
  $('activista-form').reset();
  $('form-parroquia').innerHTML =
    '<option value="">Seleccione parroquia...</option>';
  $('form-cod-centro').value = '';
  $('form-mesa').value = '';
  $('form-fecha-nacimiento').value = '';
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

  const codMun = d.codigo_municipio
    ? String(d.codigo_municipio).padStart(2, '0')
    : '';
  const codPar = d.codigo_parroquia
    ? String(d.codigo_parroquia).padStart(2, '0')
    : '';
  $('form-municipio').value = codMun;
  poblarParroquiasSelect($('form-parroquia'), codMun, codPar);

  $('form-centro').value = d.centro_votacion || '';
  $('form-cod-centro').value = d.cod_centro || '';
  $('form-mesa').value = d.mesa || '';
  $('form-fecha-nacimiento').value = d.fecha_nacimiento || '';
  $('form-comunidad').value = d.comunidad || '';
  $('form-direccion').value = d.direccion || '';
  $('form-telefono').value = d.telefono || '';
  $('form-correo').value = d.correo || '';
  cargarRedesEnContenedor(
    $('form-redes-list'),
    d.redes_sociales || '',
    false
  );
  $('form-cal').value = d.comite_activismo_local || '';
  $('form-direccion-cal').value = d.direccion_cal || '';
  $('form-resp-cal').value = d.responsable_cal || '';
  $('form-resp-local').value = d.responsable_local || '';
  $('form-resp-comunidad').value = d.responsable_comunidad || '';
  $('form-resp-municipal').value = d.responsable_municipal || '';
  $('form-enlace').value = d.enlace || '';
  if ($('form-rol-electoral')) {
    $('form-rol-electoral').value = d.rol_electoral || '';
  }
  if ($('form-estado-contacto')) {
    $('form-estado-contacto').value = d.estado_contacto || '';
  }

  actualizarBotonWhatsAppForm();

  const esAdmin = STATE.user?.rol === 'admin';
  if (modoEdicion) {
    $('btn-guardar-text').textContent = 'Actualizar Activista';
    $('btn-eliminar-activista').classList.toggle('hidden', !esAdmin);
  } else {
    $('btn-guardar-text').textContent = 'Guardar Activista';
    $('btn-eliminar-activista').classList.add('hidden');
  }
}

export async function buscarCedulaCNE(forzarCedula = null) {
  const input = $('cne-cedula-search');
  const raw = (forzarCedula !== null ? String(forzarCedula) : input.value).replace(
    /\D/g,
    ''
  );
  if (raw.length < 5 || raw.length > 12) {
    mostrarToast('Ingrese una cédula válida (entre 5 y 12 dígitos).', 'error');
    return;
  }
  input.value = raw;

  try {
    const data = await consultarElectorCached(raw);

    if (data.datos && data.datos.nacionalidad) {
      $('cne-nacionalidad').value = data.datos.nacionalidad;
    }

    if (data.encontrado_en === 'activistas') {
      cargarDatosEnFormulario(data.datos, Boolean(data.modo_edicion));
      mostrarToast(
        data.modo_edicion
          ? 'Activista ya registrado — Modo Edición.'
          : 'Cédula ya registrada en sistema (Padrón CNE cargado).',
        'info'
      );
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

// =========================================================
// PLANILLA GRUPAL EN FORMATO DE LISTA
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
    badge.className =
      'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
    badge.textContent = 'CNE OK';
  } else if (tipo === 'activistas') {
    badge.className =
      'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-200';
    badge.textContent = 'Ya existe';
  } else if (tipo === 'ninguno') {
    badge.className =
      'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200';
    badge.textContent = 'Manual';
  } else if (tipo === 'buscando') {
    badge.className =
      'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-[#2563EB] border border-blue-200';
    badge.textContent = 'Buscando...';
  } else {
    badge.className =
      'grp-estado-badge inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-400 border border-slate-200';
    badge.textContent = 'Pendiente';
  }

  const esAlerta = String(textoCentro || '').startsWith('⚠️');
  sub.className = `grp-centro-cne text-[10px] mt-1 max-w-[140px] truncate ${
    esAlerta ? 'text-amber-700 font-semibold' : 'text-slate-500'
  }`;
  sub.textContent = textoCentro;
  sub.title = textoCentro;
}

function actualizarBadgeBorrador(
  visible,
  texto = 'Borrador guardado localmente'
) {
  const badge = $('grp-borrador-badge');
  if (!badge) return;
  if (visible) {
    badge.textContent = texto;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

export function hayDatosEnPlanillaGrupal() {
  const headerIds = [
    'grp-municipio',
    'grp-parroquia',
    'grp-comunidad',
    'grp-resp-cal',
    'grp-cal',
    'grp-centro',
    'grp-direccion-cal',
    'grp-enlace',
    'grp-resp-local',
    'grp-resp-comunidad',
    'grp-resp-municipal',
  ];
  if (headerIds.some((id) => String($(id)?.value || '').trim() !== '')) {
    return true;
  }
  const rows = Array.from($('grp-filas-body').querySelectorAll('.grp-row'));
  return rows.some((tr) => {
    const ced = tr.querySelector('.grp-cedula').value.trim();
    const nom = tr.querySelector('.grp-nombre').value.trim();
    const tel = tr.querySelector('.grp-telefono').value.trim();
    const cor = tr.querySelector('.grp-correo').value.trim();
    const dir = tr.querySelector('.grp-direccion').value.trim();
    const red = serializarRedesSociales(tr.querySelector('.grp-redes-list'));
    return Boolean(ced || nom || tel || cor || dir || red);
  });
}

function guardarBorradorPlanilla() {
  if (!STATE.user) return;
  if (!hayDatosEnPlanillaGrupal()) {
    try {
      localStorage.removeItem(BORRADOR_PLANILLA_KEY);
    } catch (_) {}
    actualizarBadgeBorrador(false);
    return;
  }

  const filas = Array.from($('grp-filas-body').querySelectorAll('.grp-row')).map(
    (tr) => ({
      cedula: tr.querySelector('.grp-cedula').value,
      nombre: tr.querySelector('.grp-nombre').value,
      sexo: tr.querySelector('.grp-sexo').value,
      telefono: tr.querySelector('.grp-telefono').value,
      correo: tr.querySelector('.grp-correo').value,
      direccion: tr.querySelector('.grp-direccion').value,
      redes: serializarRedesSociales(tr.querySelector('.grp-redes-list')),
      estado: tr.dataset.estado || 'pendiente',
      lastCedula: tr.dataset.lastCedula || '',
      cneMun: tr.dataset.cneMun || '',
      cnePar: tr.dataset.cnePar || '',
      cneCentro: tr.dataset.cneCentro || '',
      cneCodCentro: tr.dataset.cneCodCentro || '',
      cneMesa: tr.dataset.cneMesa || '',
      cneFechaNac: tr.dataset.cneFechaNac || '',
      centroCneTexto: tr.querySelector('.grp-centro-cne')?.textContent || '',
    })
  );

  const payload = {
    codigo: $('grp-codigo').value,
    municipio: $('grp-municipio').value,
    parroquia: $('grp-parroquia').value,
    comunidad: $('grp-comunidad').value,
    respCal: $('grp-resp-cal').value,
    cal: $('grp-cal').value,
    centro: $('grp-centro').value,
    direccionCal: $('grp-direccion-cal').value,
    enlace: $('grp-enlace').value,
    respLocal: $('grp-resp-local').value,
    respComunidad: $('grp-resp-comunidad').value,
    respMunicipal: $('grp-resp-municipal').value,
    rolElectoral: $('grp-rol-electoral')?.value || '',
    estadoContacto: $('grp-estado-contacto')?.value || '',
    filas,
  };

  try {
    localStorage.setItem(BORRADOR_PLANILLA_KEY, JSON.stringify(payload));
    actualizarBadgeBorrador(true, 'Borrador guardado localmente');
  } catch (_) {}
}

function programarGuardadoBorrador() {
  clearTimeout(_borradorTimer);
  _borradorTimer = setTimeout(guardarBorradorPlanilla, 250);
}

export function restaurarBorradorPlanilla() {
  let raw = '';
  try {
    raw = localStorage.getItem(BORRADOR_PLANILLA_KEY) || '';
  } catch (_) {
    return;
  }
  if (!raw) return;

  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;

    if (data.municipio) {
      $('grp-municipio').value = data.municipio;
      poblarParroquiasSelect(
        $('grp-parroquia'),
        data.municipio,
        data.parroquia || ''
      );
    }
    if (data.codigo) {
      $('grp-codigo').value = data.codigo;
    }
    $('grp-comunidad').value = data.comunidad || '';
    $('grp-resp-cal').value = data.respCal || '';
    $('grp-cal').value = data.cal || '';
    $('grp-centro').value = data.centro || '';
    $('grp-direccion-cal').value = data.direccionCal || '';
    $('grp-enlace').value = data.enlace || '';
    $('grp-resp-local').value = data.respLocal || '';
    $('grp-resp-comunidad').value = data.respComunidad || '';
    $('grp-resp-municipal').value = data.respMunicipal || '';
    if ($('grp-rol-electoral')) $('grp-rol-electoral').value = data.rolElectoral || '';
    if ($('grp-estado-contacto')) $('grp-estado-contacto').value = data.estadoContacto || '';

    const filasData = Array.isArray(data.filas) ? data.filas : [];
    if (filasData.length) {
      $('grp-filas-body').innerHTML = '';
      agregarFilaPlanilla(Math.max(5, filasData.length));
      const trs = $('grp-filas-body').querySelectorAll('.grp-row');
      filasData.forEach((f, idx) => {
        const tr = trs[idx];
        if (!tr) return;
        tr.querySelector('.grp-cedula').value = f.cedula || '';
        tr.querySelector('.grp-nombre').value = f.nombre || '';
        tr.querySelector('.grp-sexo').value = f.sexo || '';
        tr.querySelector('.grp-telefono').value = f.telefono || '';
        tr.querySelector('.grp-correo').value = f.correo || '';
        tr.querySelector('.grp-direccion').value = f.direccion || '';
        cargarRedesEnContenedor(
          tr.querySelector('.grp-redes-list'),
          f.redes || '',
          true
        );
        tr.dataset.lastCedula = f.lastCedula || '';
        tr.dataset.cneMun = f.cneMun || '';
        tr.dataset.cnePar = f.cnePar || '';
        tr.dataset.cneCentro = f.cneCentro || '';
        tr.dataset.cneCodCentro = f.cneCodCentro || '';
        tr.dataset.cneMesa = f.cneMesa || '';
        tr.dataset.cneFechaNac = f.cneFechaNac || '';
        setEstadoFilaPlanilla(
          tr,
          f.estado || 'pendiente',
          f.centroCneTexto || ''
        );
      });
    }
    renumerarFilasPlanilla();
    actualizarResumenPlanilla();
    actualizarBadgeBorrador(true, 'Borrador recuperado');
  } catch (_) {}
}

async function consultarCedulaFilaPlanilla(tr, forzar = false) {
  const inputCed = tr.querySelector('.grp-cedula');
  const raw = inputCed.value.replace(/\D/g, '');
  inputCed.value = raw;

  if (raw.length < 5 || raw.length > 12) {
    if (forzar && raw.length > 0) {
      mostrarToast('La cédula debe tener entre 5 y 12 dígitos.', 'error');
    }
    tr.dataset.lastCedula = '';
    tr.dataset.cneMun = '';
    tr.dataset.cnePar = '';
    tr.dataset.cneCentro = '';
    tr.dataset.cneCodCentro = '';
    tr.dataset.cneMesa = '';
    tr.dataset.cneFechaNac = '';
    setEstadoFilaPlanilla(tr, 'pendiente', '');
    actualizarResumenPlanilla();
    programarGuardadoBorrador();
    return;
  }

  if (!forzar && tr.dataset.lastCedula === raw) return;
  tr.dataset.lastCedula = raw;
  setEstadoFilaPlanilla(tr, 'buscando', '');

  try {
    const data = await consultarElectorCached(raw);
    const d = data.datos || {};

    tr.dataset.cneMun = d.codigo_municipio || '';
    tr.dataset.cnePar = d.codigo_parroquia || '';
    tr.dataset.cneCentro = d.centro_votacion || '';
    tr.dataset.cneCodCentro = d.cod_centro || '';
    tr.dataset.cneMesa = d.mesa || '';
    tr.dataset.cneFechaNac = d.fecha_nacimiento || '';

    if (!$('grp-municipio').value && d.codigo_municipio) {
      const cm = String(d.codigo_municipio).padStart(2, '0');
      const cp = d.codigo_parroquia
        ? String(d.codigo_parroquia).padStart(2, '0')
        : '';
      $('grp-municipio').value = cm;
      poblarParroquiasSelect($('grp-parroquia'), cm, cp);
      await actualizarCodigoSiguienteGrupal(cm);
    }

    if (d.nombre_apellido) {
      tr.querySelector('.grp-nombre').value = d.nombre_apellido;
    }
    if (d.sexo) {
      tr.querySelector('.grp-sexo').value = d.sexo;
    }

    const munHdrActual = $('grp-municipio').value;
    const cneMunPadded = d.codigo_municipio
      ? String(d.codigo_municipio).padStart(2, '0')
      : '';
    const mesaTxt = d.mesa ? `M${d.mesa} · ` : '';
    let avisoCentro = `${mesaTxt}${d.centro_votacion || ''}`;
    if (munHdrActual && cneMunPadded && cneMunPadded !== munHdrActual) {
      avisoCentro = `⚠️ Vota en ${d.municipio || cneMunPadded} — ${
        d.centro_votacion || 'Sin centro'
      }`;
    }

    if (data.encontrado_en === 'activistas') {
      if (d.telefono) tr.querySelector('.grp-telefono').value = d.telefono;
      if (d.correo) tr.querySelector('.grp-correo').value = d.correo;
      if (d.direccion) tr.querySelector('.grp-direccion').value = d.direccion;
      if (d.redes_sociales) {
        cargarRedesEnContenedor(
          tr.querySelector('.grp-redes-list'),
          d.redes_sociales,
          true
        );
      }
      setEstadoFilaPlanilla(tr, 'activistas', avisoCentro);
      retriggerAnim(tr, 'animate-cne-flash');
    } else if (data.encontrado_en === 'padron') {
      setEstadoFilaPlanilla(tr, 'padron', avisoCentro);
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
  programarGuardadoBorrador();
}

export function agregarFilaPlanilla(cantidad = 1) {
  const tbody = $('grp-filas-body');
  if (!tbody) return;
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
        <p class="grp-centro-cne text-[10px] text-slate-500 mt-1 max-w-[140px] truncate"></p>
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
    inputCed.addEventListener('blur', () =>
      consultarCedulaFilaPlanilla(tr, false)
    );
    inputCed.addEventListener('input', actualizarResumenPlanilla);

    tr.querySelector('.grp-btn-cne').addEventListener('click', () => {
      consultarCedulaFilaPlanilla(tr, true);
    });

    tr.querySelector('.grp-btn-add-red').addEventListener('click', () => {
      crearFilaRedSocial(redesBox, '', '', true);
      programarGuardadoBorrador();
    });

    tr.querySelector('.grp-btn-del').addEventListener('click', () => {
      if (tbody.querySelectorAll('.grp-row').length > 1) {
        tr.remove();
        renumerarFilasPlanilla();
        actualizarResumenPlanilla();
      } else {
        tr.querySelectorAll('input, select').forEach((el) => {
          el.value = '';
        });
        tr.dataset.lastCedula = '';
        tr.dataset.cneMun = '';
        tr.dataset.cnePar = '';
        tr.dataset.cneCentro = '';
        tr.dataset.cneCodCentro = '';
        tr.dataset.cneMesa = '';
        tr.dataset.cneFechaNac = '';
        cargarRedesEnContenedor(redesBox, '', true);
        setEstadoFilaPlanilla(tr, 'pendiente', '');
        actualizarResumenPlanilla();
      }
      programarGuardadoBorrador();
    });

    tbody.appendChild(tr);
  }
  renumerarFilasPlanilla();
  actualizarResumenPlanilla();
  refreshIcons();
}

export function limpiarPlanillaGrupal(limpiarBorrador = true) {
  $('planilla-grupal-form').reset();
  $('grp-parroquia').innerHTML =
    '<option value="">Seleccione parroquia...</option>';
  $('grp-filas-body').innerHTML = '';
  STATE.ultimoCodigoSugeridoGrupal = '';
  agregarFilaPlanilla(5);
  actualizarCodigoSiguienteGrupal('01', true);
  if (limpiarBorrador) {
    clearTimeout(_borradorTimer);
    try {
      localStorage.removeItem(BORRADOR_PLANILLA_KEY);
    } catch (_) {}
    actualizarBadgeBorrador(false);
  }
}

// =========================================================
// MODAL BUSCAR POR NOMBRE EN PADRÓN CNE
// =========================================================
function abrirModalBuscarNombre(target) {
  _nombreSearchTarget = target;
  const munActual =
    target === 'grupal' ? $('grp-municipio').value : $('form-municipio').value;
  if ($('cne-nombre-mun')) {
    $('cne-nombre-mun').value = munActual || '';
    poblarParroquiasSelect(
      $('cne-nombre-par'),
      munActual || '',
      '',
      'Todas las Parroquias',
      false
    );
  }
  $('cne-nombre-input').value = '';
  $('cne-nombre-resultados').innerHTML =
    '<p class="text-xs text-slate-400 text-center py-6">Escriba al menos 2 letras (ej. CARLOS MENDOZA) y presione Buscar.</p>';
  $('cne-nombre-modal').classList.remove('hidden');
  retriggerAnim($('cne-nombre-modal-card'), 'animate-toast-in');
  setTimeout(() => $('cne-nombre-input').focus(), 40);
}

function cerrarModalBuscarNombre() {
  $('cne-nombre-modal')?.classList.add('hidden');
}

async function ejecutarBusquedaNombreCNE() {
  const q = $('cne-nombre-input').value.trim();
  if (q.length < 2) {
    mostrarToast('Ingrese al menos 2 caracteres para buscar.', 'error');
    return;
  }
  const mun = $('cne-nombre-mun').value;
  const par = $('cne-nombre-par').value;
  const box = $('cne-nombre-resultados');
  box.innerHTML =
    '<p class="text-xs text-[#2563EB] text-center py-6">Consultando Padrón CNE...</p>';

  await withButtonLoading($('btn-cne-nombre-buscar'), async () => {
    try {
      const data = await buscarPadronPorNombre(q, mun, par, 30);
      const regs = data.registros || [];
      if (!regs.length) {
        box.innerHTML =
          '<p class="text-xs text-slate-500 text-center py-6">Sin coincidencias en el padrón para este criterio.</p>';
        return;
      }
      box.innerHTML = regs
        .map(
          (r) => `
          <button
            type="button"
            data-cne-pick="${escapeHtml(r.cedula)}"
            class="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors flex items-center justify-between gap-3"
          >
            <div class="min-w-0">
              <p class="text-xs font-bold text-slate-800 truncate">${escapeHtml(r.nombre_apellido)}</p>
              <p class="text-[11px] text-slate-500 truncate">${escapeHtml(r.municipio)} / ${escapeHtml(r.parroquia)} — ${escapeHtml(r.centro_votacion)}</p>
            </div>
            <div class="text-right shrink-0">
              <span class="block font-mono text-xs font-bold text-[#2563EB]">V-${escapeHtml(r.cedula)}</span>
              ${r.mesa ? `<span class="text-[10px] text-slate-500">Mesa ${escapeHtml(r.mesa)}</span>` : ''}
            </div>
          </button>`
        )
        .join('');
    } catch (err) {
      box.innerHTML = `<p class="text-xs text-red-600 text-center py-6">${escapeHtml(err.message)}</p>`;
    }
  });
}

// =========================================================
// MODAL IMPORTAR EXCEL / CSV
// =========================================================
function abrirModalImportar() {
  _importPreviewData = null;
  $('import-file-input').value = '';
  $('import-preview-section').classList.add('hidden');
  $('btn-import-confirmar').disabled = true;
  if ($('imp-municipio').value === '' && $('grp-municipio').value) {
    $('imp-municipio').value = $('grp-municipio').value;
    poblarParroquiasSelect(
      $('imp-parroquia'),
      $('imp-municipio').value,
      $('grp-parroquia').value
    );
  }
  $('import-modal').classList.remove('hidden');
  retriggerAnim($('import-modal-card'), 'animate-toast-in');
}

function cerrarModalImportar() {
  $('import-modal')?.classList.add('hidden');
}

function renderizarPreviewImportacion(data) {
  _importPreviewData = data;
  const res = data.resumen || {};
  $('import-resumen-box').innerHTML = `
    <span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-semibold">Total: ${res.total_filas || 0}</span>
    <span class="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">CNE OK: ${res.padron || 0}</span>
    <span class="px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-semibold">Ya existe: ${res.activistas || 0}</span>
    <span class="px-2.5 py-1 rounded-full bg-blue-50 text-[#2563EB] border border-blue-200 font-semibold">Manual: ${res.ninguno || 0}</span>
    <span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-semibold">Duplicados: ${res.duplicados || 0}</span>
    <span class="px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200 font-semibold">Errores: ${res.errores || 0}</span>
  `;

  const filas = data.filas || [];
  const badges = {
    padron: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    activistas: 'bg-amber-50 text-amber-800 border-amber-200',
    ninguno: 'bg-blue-50 text-[#2563EB] border-blue-200',
    duplicado: 'bg-slate-100 text-slate-600 border-slate-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  };

  $('import-preview-body').innerHTML = filas
    .slice(0, 200)
    .map((f) => {
      const d = f.datos || {};
      return `
        <tr class="hover:bg-slate-50/70">
          <td class="px-3 py-2 font-mono text-slate-500">${f.fila_num}</td>
          <td class="px-3 py-2 font-mono font-semibold text-slate-800">${escapeHtml(d.cedula || '')}</td>
          <td class="px-3 py-2 text-slate-800 truncate max-w-[180px]">${escapeHtml(d.nombre_apellido || '-')}</td>
          <td class="px-3 py-2 text-slate-600 truncate max-w-[140px]">${escapeHtml(d.municipio || '-')}</td>
          <td class="px-3 py-2 font-mono text-slate-600">${escapeHtml(d.telefono || '-')}</td>
          <td class="px-3 py-2">
            <span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badges[f.estado] || badges.ninguno}">${escapeHtml(f.estado.toUpperCase())}</span>
            ${f.error ? `<p class="text-[10px] text-red-600 mt-0.5">${escapeHtml(f.error)}</p>` : ''}
          </td>
        </tr>`;
    })
    .join('');

  $('import-preview-section').classList.remove('hidden');
  $('btn-import-confirmar').disabled = !(res.listas > 0);
}

// =========================================================
// INICIALIZACIÓN DE EVENTOS DE REGISTRO
// =========================================================
export function initRegistro() {
  // Switch Grupal / Individual
  $('btn-modo-grupal')?.addEventListener('click', () => setRegistroModo('grupal'));
  $('btn-modo-individual')?.addEventListener('click', () =>
    setRegistroModo('individual')
  );
  window.addEventListener('resize', () => actualizarPillModoCarga(false));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => actualizarPillModoCarga(false));
  }
  requestAnimationFrame(() => actualizarPillModoCarga(false));

  // Sexo toggle
  document.querySelectorAll('.sexo-toggle').forEach((btn) => {
    btn.addEventListener('click', () => setSexoUI(btn.dataset.sexo));
  });

  // Redes sociales en formulario individual
  $('btn-add-form-red')?.addEventListener('click', () => {
    crearFilaRedSocial($('form-redes-list'), '', '', false);
  });
  cargarRedesEnContenedor($('form-redes-list'), '', false);
  $('form-telefono')?.addEventListener('input', actualizarBotonWhatsAppForm);

  // Selectores geográficos y códigos
  $('grp-municipio')?.addEventListener('change', async (e) => {
    const codMun = e.target.value;
    poblarParroquiasSelect($('grp-parroquia'), codMun);
    await actualizarCodigoSiguienteGrupal(codMun || '01');
  });
  $('form-municipio')?.addEventListener('change', async (e) => {
    const codMun = e.target.value;
    poblarParroquiasSelect($('form-parroquia'), codMun);
    await actualizarCodigoSiguiente(codMun || '01');
  });
  $('grp-codigo')?.addEventListener('blur', () => {
    const norm = normalizarInputCodigoPlanilla(
      $('grp-codigo').value,
      $('grp-municipio').value || '01'
    );
    if (norm) $('grp-codigo').value = norm;
    programarGuardadoBorrador();
  });
  $('form-codigo')?.addEventListener('blur', () => {
    const norm = normalizarInputCodigoPlanilla(
      $('form-codigo').value,
      $('form-municipio').value || '01'
    );
    if (norm) $('form-codigo').value = norm;
  });

  const aplicarRepGrupal = () => {
    const codMun = $('grp-municipio').value || '01';
    const codRep = armarCodigoPorRepresentante(
      codMun,
      $('grp-enlace').value,
      $('grp-resp-cal').value
    );
    if (codRep) {
      $('grp-codigo').value = codRep;
      STATE.ultimoCodigoSugeridoGrupal = codRep;
      programarGuardadoBorrador();
    }
  };
  const aplicarRepForm = () => {
    if (STATE.modoEdicion) return;
    const codMun = $('form-municipio').value || '01';
    const codRep = armarCodigoPorRepresentante(
      codMun,
      $('form-enlace').value,
      $('form-resp-cal').value
    );
    if (codRep) $('form-codigo').value = codRep;
  };
  ['grp-enlace', 'grp-resp-cal'].forEach((id) => {
    $(id)?.addEventListener('change', aplicarRepGrupal);
    $(id)?.addEventListener('blur', () => setTimeout(aplicarRepGrupal, 140));
  });
  ['form-enlace', 'form-resp-cal'].forEach((id) => {
    $(id)?.addEventListener('change', aplicarRepForm);
    $(id)?.addEventListener('blur', () => setTimeout(aplicarRepForm, 140));
  });

  // Búsqueda individual CNE
  $('btn-buscar-cne')?.addEventListener('click', () => buscarCedulaCNE());
  $('cne-cedula-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      buscarCedulaCNE();
    }
  });
  $('btn-limpiar-form')?.addEventListener('click', () => {
    $('cne-cedula-search').value = '';
    limpiarFormulario();
  });

  // Submit Individual
  $('activista-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const codForm = normalizarInputCodigoPlanilla(
      $('form-codigo').value,
      $('form-municipio').value || '01'
    );
    $('form-codigo').value = codForm;
    const payload = {
      cedula: $('form-cedula').value,
      codigo: codForm,
      nombre_apellido: $('form-nombre').value,
      sexo: $('form-sexo').value,
      codigo_municipio: $('form-municipio').value,
      codigo_parroquia: $('form-parroquia').value,
      centro_votacion: $('form-centro').value,
      cod_centro: $('form-cod-centro').value,
      mesa: $('form-mesa').value,
      fecha_nacimiento: $('form-fecha-nacimiento').value,
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
      rol_electoral: $('form-rol-electoral')?.value || '',
      estado_contacto: $('form-estado-contacto')?.value || '',
    };

    await withButtonLoading($('btn-guardar-activista'), async () => {
      try {
        const res = await apiFetch('/api/activistas', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        STATE.cneCache.delete(data.activista.cedula);
        upsertActivistaEnMemoria(data.activista);
        mostrarToast(
          `Activista ${data.activista.nombre_apellido} (${data.activista.codigo}) guardado.`,
          'ok'
        );
        cargarDatosEnFormulario(data.activista, true);
        actualizarTarjetaResumen(data.activista, 'activistas');
        await STATE.callbacks.onDataChanged?.({ reloadEstructura: true });
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  // Eliminar Individual
  $('btn-eliminar-activista')?.addEventListener('click', async () => {
    const cedula = $('form-cedula').value.replace(/\D/g, '');
    if (!cedula) return;
    const nombre = $('form-nombre').value.trim();
    const detalle = nombre ? `${nombre} (C.I. ${cedula})` : `C.I. ${cedula}`;
    const confirmado = await pedirConfirmacion({
      titulo: 'Eliminar activista',
      mensaje: `¿Confirma eliminar permanentemente a ${detalle}?\n\nEl registro será eliminado de la base de datos del sistema.`,
      textoConfirmar: 'Sí, eliminar',
      variante: 'danger',
    });
    if (!confirmado) return;

    await withButtonLoading($('btn-eliminar-activista'), async () => {
      try {
        await apiFetch(`/api/activistas/${encodeURIComponent(cedula)}`, {
          method: 'DELETE',
        });
        STATE.cneCache.delete(cedula);
        mostrarToast(`Activista ${cedula} eliminado.`, 'ok');
        $('cne-cedula-search').value = '';
        limpiarFormulario();
        await STATE.callbacks.onActivistaEliminado?.(cedula);
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  // Filas Planilla Grupal
  $('btn-grp-add-1')?.addEventListener('click', () => {
    agregarFilaPlanilla(1);
    programarGuardadoBorrador();
  });
  $('btn-grp-add-5')?.addEventListener('click', () => {
    agregarFilaPlanilla(5);
    programarGuardadoBorrador();
  });
  $('btn-limpiar-planilla')?.addEventListener('click', async () => {
    if (hayDatosEnPlanillaGrupal()) {
      const ok = await pedirConfirmacion({
        titulo: 'Limpiar planilla grupal',
        mensaje:
          'Se descartarán los datos no guardados de esta planilla y su borrador local. ¿Desea continuar?',
        textoConfirmar: 'Limpiar planilla',
        variante: 'danger',
      });
      if (!ok) return;
    }
    limpiarPlanillaGrupal(true);
  });
  $('planilla-grupal-form')?.addEventListener('input', programarGuardadoBorrador);
  $('planilla-grupal-form')?.addEventListener('change', programarGuardadoBorrador);
  agregarFilaPlanilla(5);

  // Submit Planilla Grupal
  $('planilla-grupal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const codMunHdr = $('grp-municipio').value;
    const codParHdr = $('grp-parroquia').value;
    if (!codMunHdr || !codParHdr) {
      mostrarToast(
        'Seleccione el Municipio y la Parroquia en la cabecera de la planilla.',
        'error'
      );
      return;
    }

    const codigoPlanilla = normalizarInputCodigoPlanilla(
      $('grp-codigo').value,
      codMunHdr
    );
    $('grp-codigo').value = codigoPlanilla;
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
      rol_electoral: $('grp-rol-electoral')?.value || '',
      estado_contacto: $('grp-estado-contacto')?.value || '',
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
        const redes = serializarRedesSociales(
          tr.querySelector('.grp-redes-list')
        );

        const tieneAlgunDato = Boolean(
          ced || nombre || tel || correo || dir || redes
        );
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

        const usarGeoCne = Boolean(tr.dataset.cneMun && tr.dataset.cnePar);
        activistas.push(
          Object.assign({}, cabecera, {
            cedula: ced,
            nombre_apellido: nombre,
            sexo: tr.querySelector('.grp-sexo').value,
            telefono: tel,
            correo,
            direccion: dir,
            redes_sociales: redes,
            codigo_municipio: usarGeoCne ? tr.dataset.cneMun : codMunHdr,
            codigo_parroquia: usarGeoCne ? tr.dataset.cnePar : codParHdr,
            centro_votacion: tr.dataset.cneCentro || centroCercanoHdr,
            cod_centro: tr.dataset.cneCodCentro || '',
            mesa: tr.dataset.cneMesa || '',
            fecha_nacimiento: tr.dataset.cneFechaNac || '',
          })
        );
      });

    if (filaError) {
      mostrarToast(filaError, 'error');
      return;
    }
    if (!activistas.length) {
      mostrarToast(
        'Ingrese al menos una persona en la lista antes de guardar.',
        'error'
      );
      return;
    }

    await withButtonLoading($('btn-guardar-planilla'), async () => {
      try {
        let totalProc = 0;
        let nuevos = 0;
        let actualizados = 0;
        let codFinal = codigoPlanilla;

        for (let i = 0; i < activistas.length; i += 500) {
          const chunk = activistas.slice(i, i + 500);
          const res = await apiFetch('/api/activistas/lote', {
            method: 'POST',
            body: JSON.stringify({ activistas: chunk }),
          });
          const data = await res.json();
          totalProc += data.total_procesados || 0;
          nuevos += data.nuevos || 0;
          actualizados += data.actualizados || 0;
          if (data.codigo_planilla) codFinal = data.codigo_planilla;
          (data.activistas || []).forEach((a) => {
            STATE.cneCache.delete(a.cedula);
            upsertActivistaEnMemoria(a);
          });
        }

        mostrarToast(
          `Planilla ${codFinal} guardada: ${totalProc} persona(s) (${nuevos} nueva(s), ${actualizados} actualizada(s)).`,
          'ok'
        );
        limpiarPlanillaGrupal(true);
        await STATE.callbacks.onDataChanged?.({ reloadEstructura: true });
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  // Comboboxes de Estructura, Campos Activista y Centros CNE
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
    ['imp-enlace', 'enlace', () => $('imp-municipio').value],
    ['imp-resp-cal', 'responsable_cal', () => $('imp-municipio').value],
    ['imp-resp-municipal', 'responsable_municipal', () => $('imp-municipio').value],
  ].forEach(([id, rol, getMun]) => {
    crearCombobox($(id), {
      tipo: 'estructura',
      rol,
      getMunCode: getMun,
      ariaLabel: `Ver opciones de ${rol}`,
    });
  });

  [
    ['grp-comunidad', 'comunidad', () => $('grp-municipio').value, () => $('grp-parroquia').value, true],
    ['form-comunidad', 'comunidad', () => $('form-municipio').value, () => $('form-parroquia').value, true],
    ['grp-cal', 'comite_activismo_local', () => $('grp-municipio').value, () => $('grp-parroquia').value, true],
    ['form-cal', 'comite_activismo_local', () => $('form-municipio').value, () => $('form-parroquia').value, true],
  ].forEach(([id, campoKey, getMun, getPar, upper]) => {
    crearCombobox($(id), {
      tipo: 'activista',
      campoKey,
      getMunCode: getMun,
      getParCode: getPar,
      forzarMayusculas: upper,
    });
  });

  crearCombobox($('grp-centro'), {
    tipo: 'centros_cne',
    getMunCode: () => $('grp-municipio').value,
    getParCode: () => $('grp-parroquia').value,
    forzarMayusculas: false,
  });
  crearCombobox($('form-centro'), {
    tipo: 'centros_cne',
    getMunCode: () => $('form-municipio').value,
    getParCode: () => $('form-parroquia').value,
    forzarMayusculas: false,
    onSelect: (centro) => {
      if ($('form-cod-centro')) $('form-cod-centro').value = centro.cod_centro || '';
    },
  });

  // Modal Buscar por Nombre en CNE
  $('btn-abrir-buscar-nombre')?.addEventListener('click', () =>
    abrirModalBuscarNombre('individual')
  );
  $('btn-grp-buscar-nombre')?.addEventListener('click', () =>
    abrirModalBuscarNombre('grupal')
  );
  $('btn-cerrar-cne-nombre')?.addEventListener('click', cerrarModalBuscarNombre);
  $('cne-nombre-modal-backdrop')?.addEventListener('click', cerrarModalBuscarNombre);
  $('cne-nombre-mun')?.addEventListener('change', (e) => {
    poblarParroquiasSelect(
      $('cne-nombre-par'),
      e.target.value,
      '',
      'Todas las Parroquias',
      false
    );
  });
  $('btn-cne-nombre-buscar')?.addEventListener('click', ejecutarBusquedaNombreCNE);
  $('cne-nombre-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      ejecutarBusquedaNombreCNE();
    }
  });
  $('cne-nombre-resultados')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cne-pick]');
    if (!btn) return;
    const ced = btn.dataset.cnePick;
    cerrarModalBuscarNombre();
    if (_nombreSearchTarget === 'individual') {
      await buscarCedulaCNE(ced);
    } else {
      const filas = Array.from($('grp-filas-body').querySelectorAll('.grp-row'));
      let targetTr = filas.find(
        (tr) => !tr.querySelector('.grp-cedula').value.trim()
      );
      if (!targetTr) {
        agregarFilaPlanilla(1);
        const nuevas = $('grp-filas-body').querySelectorAll('.grp-row');
        targetTr = nuevas[nuevas.length - 1];
      }
      targetTr.querySelector('.grp-cedula').value = ced;
      await consultarCedulaFilaPlanilla(targetTr, true);
      targetTr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  // Modal Importar Excel / CSV
  $('btn-abrir-importar')?.addEventListener('click', abrirModalImportar);
  $('btn-cerrar-import-modal')?.addEventListener('click', cerrarModalImportar);
  $('btn-cancelar-import')?.addEventListener('click', cerrarModalImportar);
  $('import-modal-backdrop')?.addEventListener('click', cerrarModalImportar);
  $('imp-municipio')?.addEventListener('change', (e) => {
    poblarParroquiasSelect($('imp-parroquia'), e.target.value);
  });

  $('btn-import-preview')?.addEventListener('click', async () => {
    const fileInput = $('import-file-input');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      mostrarToast('Seleccione un archivo .xlsx o .csv primero.', 'error');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    await withButtonLoading($('btn-import-preview'), async () => {
      try {
        const res = await apiFetch('/api/activistas/importar/preview', {
          method: 'POST',
          body: fd,
        });
        const data = await res.json();
        renderizarPreviewImportacion(data);
        mostrarToast('Archivo analizado contra el Padrón CNE.', 'ok');
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    }, 'Analizando...');
  });

  $('btn-import-confirmar')?.addEventListener('click', async () => {
    if (!_importPreviewData || !Array.isArray(_importPreviewData.filas)) return;
    const munFallback = $('imp-municipio').value;
    const parFallback = $('imp-parroquia').value;
    const codFallback = normalizarInputCodigoPlanilla(
      $('imp-codigo').value,
      munFallback || '01'
    );
    const calFallback = $('imp-cal').value.trim();
    const respCalFallback = $('imp-resp-cal').value.trim();
    const enlaceFallback = $('imp-enlace').value.trim();
    const respMunFallback = $('imp-resp-municipal').value.trim();

    const validas = [];
    let faltantesGeo = 0;

    for (const f of _importPreviewData.filas) {
      if (!['padron', 'activistas', 'ninguno'].includes(f.estado)) continue;
      const d = Object.assign({}, f.datos);
      if (!d.codigo_municipio && munFallback) d.codigo_municipio = munFallback;
      if (!d.codigo_parroquia && parFallback) d.codigo_parroquia = parFallback;
      if (!d.codigo && codFallback) d.codigo = codFallback;
      if (!d.comite_activismo_local && calFallback)
        d.comite_activismo_local = calFallback;
      if (!d.responsable_cal && respCalFallback)
        d.responsable_cal = respCalFallback;
      if (!d.enlace && enlaceFallback) d.enlace = enlaceFallback;
      if (!d.responsable_municipal && respMunFallback)
        d.responsable_municipal = respMunFallback;

      if (!d.codigo_municipio || !d.codigo_parroquia) {
        faltantesGeo += 1;
        continue;
      }
      validas.push(d);
    }

    if (faltantesGeo > 0 && !validas.length) {
      mostrarToast(
        'Seleccione Municipio y Parroquia de respaldo para filas sin ubicación.',
        'error'
      );
      return;
    }
    if (faltantesGeo > 0) {
      const ok = await pedirConfirmacion({
        titulo: 'Filas sin Municipio/Parroquia',
        mensaje: `Hay ${faltantesGeo} fila(s) sin Municipio/Parroquia de respaldo que se omitirán. ¿Importar las ${validas.length} fila(s) válidas?`,
        textoConfirmar: 'Importar válidas',
      });
      if (!ok) return;
    }

    await withButtonLoading($('btn-import-confirmar'), async () => {
      try {
        let total = 0;
        let nuevos = 0;
        let actualizados = 0;
        for (let i = 0; i < validas.length; i += 500) {
          const chunk = validas.slice(i, i + 500);
          const res = await apiFetch('/api/activistas/lote', {
            method: 'POST',
            body: JSON.stringify({ activistas: chunk }),
          });
          const data = await res.json();
          total += data.total_procesados || 0;
          nuevos += data.nuevos || 0;
          actualizados += data.actualizados || 0;
          (data.activistas || []).forEach((a) => {
            STATE.cneCache.delete(a.cedula);
            upsertActivistaEnMemoria(a);
          });
        }
        cerrarModalImportar();
        mostrarToast(
          `Importación completada: ${total} registro(s) (${nuevos} nuevo(s), ${actualizados} actualizado(s)).`,
          'ok'
        );
        await STATE.callbacks.onDataChanged?.({ reloadEstructura: true });
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    }, 'Importando...');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('cne-nombre-modal') && !$('cne-nombre-modal').classList.contains('hidden')) {
        cerrarModalBuscarNombre();
      }
      if ($('import-modal') && !$('import-modal').classList.contains('hidden')) {
        cerrarModalImportar();
      }
    }
  });
}

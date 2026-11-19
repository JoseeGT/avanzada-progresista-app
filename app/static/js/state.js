export const BORRADOR_PLANILLA_KEY = 'ap_borrador_planilla_v1';

export const REDES_PLATAFORMAS = [
  'Instagram',
  'Facebook',
  'X (Twitter)',
  'TikTok',
  'YouTube',
  'Telegram',
  'Otra',
];

export const ROLES_ELECTORALES = [
  'MILITANTE',
  'TESTIGO PRINCIPAL',
  'TESTIGO SUPLENTE',
  'COORDINADOR DE CENTRO',
  'MOVILIZADOR',
];

export const ESTADOS_CONTACTO = [
  'POR CONTACTAR',
  'CONTACTADO',
  'CONFIRMADO',
];

export const ESTRUCTURA_ROLES = {
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

export const STATE = {
  user: null,
  multiUsuario: false,
  idleSeconds: 3600,
  catalogo: [],
  centrosCne: [],
  modoEdicion: false,
  registroModo: 'grupal', // 'grupal' | 'individual'
  ultimoCodigoSugeridoGrupal: '',
  ultimoListado: [],
  todosActivistas: [],
  activistasCargados: false,
  cneCache: new Map(),
  sortCol: 'codigo',
  sortDir: 'asc',
  estructura: [],
  estRolFiltro: '',
  vistaDirectorio: 'tabla', // 'tabla' | 'cards' | 'planillas'
  paginaDirectorio: 1,
  porPaginaDirectorio: 50,
  imprimiendoDirectorio: false,
  selectedCedulas: new Set(),
  coberturaCache: null,
  calidadCache: null,
  printTarget: 'directorio', // 'directorio' | 'analitica'
  charts: {
    municipio: null,
    parroquiaComunidad: null,
    centro: null,
    responsables: null,
    demografia: null,
    operativa: null,
  },
  callbacks: {},
};

export const $ = (id) => document.getElementById(id);

export function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizarFiltroTexto(val) {
  return String(val || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function normalizarClaveEs(val) {
  const mapa = {
    Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ü: 'U',
    À: 'A', È: 'E', Ì: 'I', Ò: 'O', Ù: 'U',
    Â: 'A', Ê: 'E', Î: 'I', Ô: 'O', Û: 'U',
  };
  return String(val || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/[ÁÉÍÓÚÜÀÈÌÒÙÂÊÎÔÛ]/g, (c) => mapa[c] || c);
}

export function normalizarNombreEstructura(val) {
  return String(val || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function normalizarWhatsApp(telefono) {
  const digits = String(telefono || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('58')) return digits;
  if (digits.startsWith('0')) return '58' + digits.slice(1);
  return '58' + digits;
}

export function obtenerIniciales(nombre) {
  const parts = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'AP';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function calcularEdad(fechaNacimiento) {
  const raw = String(fechaNacimiento || '').trim();
  if (raw.length < 4) return null;
  const hoy = new Date();
  if (raw.length >= 10) {
    const [y, m, d] = raw.slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return null;
    let edad = hoy.getFullYear() - y;
    const mesDiff = hoy.getMonth() + 1 - m;
    if (mesDiff < 0 || (mesDiff === 0 && hoy.getDate() < d)) edad -= 1;
    return edad >= 0 && edad <= 120 ? edad : null;
  }
  const y = Number(raw.slice(0, 4));
  if (!y) return null;
  const edad = hoy.getFullYear() - y;
  return edad >= 0 && edad <= 120 ? edad : null;
}

export function retriggerAnim(el, className) {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

export function animarNumeroKPI(el, targetVal) {
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

export function poblarParroquiasSelect(
  selectEl,
  codMun,
  selectedCodPar = '',
  placeholder = 'Seleccione parroquia...',
  incluirTodasSiVacio = false
) {
  if (!selectEl) return;
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

export function normalizarInputCodigoPlanilla(raw, codMun = '01') {
  const mun = String(codMun || '01').trim().padStart(2, '0');
  const limpio = String(raw || '').replace(/\s+/g, '').trim().toUpperCase();
  if (!limpio) return '';
  if (/^\d{1,2}$/.test(limpio)) {
    return `AP-${mun}-${limpio.padStart(2, '0')}`;
  }
  const match = limpio.match(/^(?:AP-)?(\d{1,2})-(\d{1,4})$/);
  if (match) {
    const mMun = String(Number(match[1])).padStart(2, '0');
    const repRaw = match[2];
    const mRep = repRaw.length <= 2 ? String(Number(repRaw)).padStart(2, '0') : repRaw;
    return `AP-${mMun}-${mRep}`;
  }
  return limpio;
}

export function obtenerCodigoRepresentante(nombre, preferRol = '') {
  const norm = normalizarClaveEs(nombre);
  if (!norm) return '';
  const rolesOrden = preferRol
    ? [preferRol, 'enlace', 'responsable_cal']
    : ['enlace', 'responsable_cal'];
  for (const rol of rolesOrden) {
    const match = STATE.estructura.find(
      (it) => it.rol === rol && normalizarClaveEs(it.nombre) === norm && it.codigo_representante
    );
    if (match) return String(match.codigo_representante).trim().toUpperCase();
  }
  return '';
}

export function armarCodigoPorRepresentante(codMun, nombreEnlace, nombreRespCal) {
  const mun = String(codMun || '01').trim().padStart(2, '0');
  const rep =
    obtenerCodigoRepresentante(nombreEnlace, 'enlace') ||
    obtenerCodigoRepresentante(nombreRespCal, 'responsable_cal');
  return rep ? `AP-${mun}-${rep}` : '';
}

export function upsertActivistaEnMemoria(act) {
  if (!act || !act.cedula) return;
  const idx = STATE.todosActivistas.findIndex((x) => x.cedula === act.cedula);
  if (idx >= 0) {
    STATE.todosActivistas[idx] = act;
  } else {
    STATE.todosActivistas.push(act);
  }
  STATE.activistasCargados = true;
}

export function removerActivistaEnMemoria(cedula) {
  const ced = String(cedula || '').replace(/\D/g, '');
  STATE.todosActivistas = STATE.todosActivistas.filter((x) => x.cedula !== ced);
  STATE.selectedCedulas.delete(ced);
}

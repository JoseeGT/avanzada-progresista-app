import {
  apiFetch,
  mostrarToast,
  pedirConfirmacion,
  withButtonLoading,
} from './api.js';
import { crearCombobox } from './combobox.js';
import {
  cargarRedesEnContenedor,
  crearFilaRedSocial,
  parsearRedesSociales,
  construirUrlRedSocial,
  serializarRedesSociales,
} from './registro.js';
import {
  $,
  STATE,
  calcularEdad,
  escapeHtml,
  normalizarFiltroTexto,
  normalizarInputCodigoPlanilla,
  normalizarWhatsApp,
  poblarParroquiasSelect,
  refreshIcons,
  removerActivistaEnMemoria,
  retriggerAnim,
  upsertActivistaEnMemoria,
} from './state.js';

const _SVG_WA =
  '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';

let _filtroDebounceTimer = null;
let RPT_LOGO_DATA_URL = '';

try {
  RPT_LOGO_DATA_URL = localStorage.getItem('ap_rpt_logo') || '';
} catch (_) {}

export function renderizarChipsMunicipios() {
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
}

function interpretarBusquedaPrincipal() {
  const raw = $('flt-cedula').value.trim();
  if (!raw) return { cedula: '', nombre: '' };
  if (/^[vVeE]?-?\d[\d.\-\s]*$/.test(raw)) {
    return { cedula: raw.replace(/\D/g, ''), nombre: '' };
  }
  return { cedula: '', nombre: raw };
}

export function obtenerQueryFiltros() {
  const params = new URLSearchParams();
  const principal = interpretarBusquedaPrincipal();
  const mapa = {
    cedula: principal.cedula,
    nombre: principal.nombre,
    codigo: $('flt-codigo').value.trim(),
    codigo_municipio: $('flt-municipio').value,
    codigo_parroquia: $('flt-parroquia').value,
    centro_votacion: $('flt-centro').value.trim(),
    cal: $('flt-cal').value.trim(),
    comunidad: $('flt-comunidad').value.trim(),
    responsable_comunidad: $('flt-resp-comunidad').value.trim(),
    enlace: $('flt-enlace').value.trim(),
    responsable_cal: $('flt-resp-cal').value.trim(),
    responsable_local: $('flt-resp-local').value.trim(),
    responsable_municipal: $('flt-resp-municipal').value.trim(),
    rol_electoral: $('flt-rol-electoral')?.value || '',
    estado_contacto: $('flt-estado-contacto')?.value || '',
  };
  for (const [k, v] of Object.entries(mapa)) {
    if (v) params.set(k, v);
  }
  return params;
}

function actualizarIndicadoresOrden() {
  document.querySelectorAll('.dir-sort-th').forEach((th) => {
    const ind = th.querySelector('.sort-indicator');
    if (!ind) return;
    if (th.dataset.sortCol === STATE.sortCol) {
      ind.textContent = STATE.sortDir === 'asc' ? '▲' : '▼';
      ind.classList.remove('text-slate-400');
      ind.classList.add('text-[#2563EB]');
    } else {
      ind.textContent = '↕';
      ind.classList.add('text-slate-400');
      ind.classList.remove('text-[#2563EB]');
    }
  });
}

function actualizarBarraAccionesBloque() {
  const bar = $('bulk-actions-bar');
  const cntEl = $('bulk-selected-count');
  if (!bar || !cntEl) return;
  const esAdmin = STATE.user?.rol === 'admin';
  const count = STATE.selectedCedulas.size;
  if (!esAdmin || count === 0) {
    bar.classList.add('hidden');
  } else {
    cntEl.textContent = `${count} seleccionado(s)`;
    bar.classList.remove('hidden');
  }
}

export function limpiarFiltrosDirectorioSoloInputs() {
  $('flt-cedula').value = '';
  $('flt-codigo').value = '';
  $('flt-municipio').value = '';
  poblarParroquiasSelect(
    $('flt-parroquia'),
    '',
    '',
    'Todas las Parroquias',
    true
  );
  $('flt-centro').value = '';
  $('flt-cal').value = '';
  $('flt-comunidad').value = '';
  $('flt-resp-comunidad').value = '';
  $('flt-enlace').value = '';
  $('flt-resp-cal').value = '';
  $('flt-resp-local').value = '';
  $('flt-resp-municipal').value = '';
  if ($('flt-rol-electoral')) $('flt-rol-electoral').value = '';
  if ($('flt-estado-contacto')) $('flt-estado-contacto').value = '';
}

export function aplicarFiltrosEnMemoria(resetPage = true) {
  if (resetPage) {
    STATE.paginaDirectorio = 1;
  }
  const principal = interpretarBusquedaPrincipal();
  const cedQ = principal.cedula;
  const nomQ = normalizarFiltroTexto(principal.nombre);
  const codQ = normalizarFiltroTexto($('flt-codigo').value);
  const munRaw = $('flt-municipio').value.trim();
  const munQ = munRaw ? munRaw.padStart(2, '0') : '';
  const parRaw = $('flt-parroquia').value.trim();
  const parQ = parRaw ? parRaw.padStart(2, '0') : '';
  const centroQ = normalizarFiltroTexto($('flt-centro').value);
  const calQ = normalizarFiltroTexto($('flt-cal').value);
  const comunidadQ = normalizarFiltroTexto($('flt-comunidad').value);
  const respComQ = normalizarFiltroTexto($('flt-resp-comunidad').value);
  const enlaceQ = normalizarFiltroTexto($('flt-enlace').value);
  const respCalQ = normalizarFiltroTexto($('flt-resp-cal').value);
  const respLocQ = normalizarFiltroTexto($('flt-resp-local').value);
  const respMunQ = normalizarFiltroTexto($('flt-resp-municipal').value);
  const rolElQ = normalizarFiltroTexto($('flt-rol-electoral')?.value || '');
  const estConQ = normalizarFiltroTexto($('flt-estado-contacto')?.value || '');

  const resultados = STATE.todosActivistas
    .filter((r) => {
      if (cedQ && !String(r.cedula || '').includes(cedQ)) return false;
      if (nomQ && !normalizarFiltroTexto(r.nombre_apellido).includes(nomQ))
        return false;
      if (codQ && !normalizarFiltroTexto(r.codigo).includes(codQ)) return false;
      if (munQ && String(r.codigo_municipio || '').padStart(2, '0') !== munQ)
        return false;
      if (parQ && String(r.codigo_parroquia || '').padStart(2, '0') !== parQ)
        return false;
      if (
        centroQ &&
        !normalizarFiltroTexto(r.centro_votacion).includes(centroQ)
      )
        return false;
      if (
        calQ &&
        !normalizarFiltroTexto(r.comite_activismo_local).includes(calQ)
      )
        return false;
      if (
        comunidadQ &&
        !normalizarFiltroTexto(r.comunidad).includes(comunidadQ)
      )
        return false;
      if (
        respComQ &&
        !normalizarFiltroTexto(r.responsable_comunidad).includes(respComQ)
      )
        return false;
      if (enlaceQ && !normalizarFiltroTexto(r.enlace).includes(enlaceQ))
        return false;
      if (
        respCalQ &&
        !normalizarFiltroTexto(r.responsable_cal).includes(respCalQ)
      )
        return false;
      if (
        respLocQ &&
        !normalizarFiltroTexto(r.responsable_local).includes(respLocQ)
      )
        return false;
      if (
        respMunQ &&
        !normalizarFiltroTexto(r.responsable_municipal).includes(respMunQ)
      )
        return false;
      if (
        rolElQ &&
        normalizarFiltroTexto(r.rol_electoral || '') !== rolElQ
      )
        return false;
      if (
        estConQ &&
        normalizarFiltroTexto(r.estado_contacto || '') !== estConQ
      )
        return false;
      return true;
    })
    .sort((a, b) => {
      const dir = STATE.sortDir === 'desc' ? -1 : 1;
      if (STATE.sortCol === 'cedula') {
        const na = Number(String(a.cedula || '').replace(/\D/g, '')) || 0;
        const nb = Number(String(b.cedula || '').replace(/\D/g, '')) || 0;
        return (na - nb) * dir;
      }
      const getVal = (item) => {
        if (STATE.sortCol === 'municipio') {
          return `${item.municipio || ''} ${item.parroquia || ''}`.trim();
        }
        return String(item[STATE.sortCol] || '');
      };
      return getVal(a).localeCompare(getVal(b), 'es') * dir;
    });

  STATE.ultimoListado = resultados;
  $('listado-conteo').textContent = `${resultados.length} resultado(s)`;
  actualizarIndicadoresOrden();
  renderizarDirectorio();
}

export async function cargarListado() {
  try {
    const res = await apiFetch('/api/activistas');
    const data = await res.json();
    STATE.todosActivistas = data.registros || [];
    STATE.activistasCargados = true;
    renderizarChipsMunicipios();
    aplicarFiltrosEnMemoria(false);
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

export function setVistaDirectorio(modo) {
  STATE.vistaDirectorio = modo;
  const tablaWrap = $('contenedor-vista-tabla');
  const cardsWrap = $('contenedor-vista-cards');
  const planillasWrap = $('contenedor-vista-planillas');
  const pagBar = $('paginacion-directorio');

  [tablaWrap, cardsWrap, planillasWrap].forEach((el) => {
    if (!el) return;
    el.classList.add('hidden');
  });

  const btnMap = {
    tabla: $('view-mode-tabla'),
    cards: $('view-mode-cards'),
    planillas: $('view-mode-planillas'),
  };
  Object.entries(btnMap).forEach(([k, btn]) => {
    if (!btn) return;
    if (k === modo) {
      btn.classList.add('bg-white', 'text-[#2563EB]', 'shadow-sm');
      btn.classList.remove('text-slate-600');
    } else {
      btn.classList.remove('bg-white', 'text-[#2563EB]', 'shadow-sm');
      btn.classList.add('text-slate-600');
    }
  });

  if (modo === 'tabla') {
    tablaWrap.classList.remove('hidden');
    pagBar?.classList.remove('hidden');
  } else if (modo === 'cards') {
    cardsWrap.classList.remove('hidden');
    pagBar?.classList.remove('hidden');
  } else if (modo === 'planillas') {
    planillasWrap?.classList.remove('hidden');
    pagBar?.classList.add('hidden');
  }

  renderizarDirectorio();
}

function actualizarBarraPaginacion(total, inicio, fin, totalPaginas) {
  const infoEl = $('paginacion-info');
  const pageEl = $('paginacion-pagina-actual');
  const prevBtn = $('btn-pag-prev');
  const nextBtn = $('btn-pag-next');
  if (!infoEl || !pageEl || !prevBtn || !nextBtn) return;

  if (total === 0) {
    infoEl.textContent = 'Mostrando 0 de 0 registros';
    pageEl.textContent = 'Página 1 / 1';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  if (STATE.porPaginaDirectorio === 0) {
    infoEl.textContent = `Mostrando ${total} de ${total} registros`;
    pageEl.textContent = 'Página 1 / 1';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  infoEl.textContent = `Mostrando ${inicio + 1}–${fin} de ${total} registros`;
  pageEl.textContent = `Página ${STATE.paginaDirectorio} / ${totalPaginas}`;
  prevBtn.disabled = STATE.paginaDirectorio <= 1;
  nextBtn.disabled = STATE.paginaDirectorio >= totalPaginas;
}

function renderizarVistaPlanillas(todosFiltrados) {
  const box = $('contenedor-vista-planillas');
  if (!box) return;

  if (!todosFiltrados.length) {
    box.innerHTML =
      '<div class="col-span-full bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">No hay planillas para los filtros seleccionados.</div>';
    return;
  }

  const grupos = new Map();
  for (const r of todosFiltrados) {
    const cod = String(r.codigo || '').trim().toUpperCase() || 'SIN CÓDIGO';
    let grp = grupos.get(cod);
    if (!grp) {
      grp = {
        codigo: cod,
        total: 0,
        municipio: r.municipio || '',
        parroquia: r.parroquia || '',
        cal: r.comite_activismo_local || '',
        enlace: r.enlace || '',
        respCal: r.responsable_cal || '',
        respMun: r.responsable_municipal || '',
        comunidad: r.comunidad || '',
      };
      grupos.set(cod, grp);
    }
    grp.total += 1;
    if (!grp.cal && r.comite_activismo_local) grp.cal = r.comite_activismo_local;
    if (!grp.enlace && r.enlace) grp.enlace = r.enlace;
    if (!grp.respCal && r.responsable_cal) grp.respCal = r.responsable_cal;
  }

  const lista = Array.from(grupos.values()).sort((a, b) =>
    a.codigo.localeCompare(b.codigo)
  );

  box.innerHTML = lista
    .map(
      (g) => `
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col justify-between space-y-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <span class="inline-block px-2.5 py-0.5 rounded-lg bg-blue-50 text-[#2563EB] font-mono text-xs font-bold">${escapeHtml(g.codigo)}</span>
            <p class="text-xs font-bold text-slate-800 mt-1.5">${escapeHtml(g.municipio || '-')} / ${escapeHtml(g.parroquia || '-')}</p>
            ${g.comunidad ? `<p class="text-[11px] text-slate-500">${escapeHtml(g.comunidad)}</p>` : ''}
          </div>
          <span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-800 font-mono text-xs font-bold">${g.total} pers.</span>
        </div>
        <div class="text-[11px] space-y-1 border-t border-slate-100 pt-2 text-slate-600">
          <p><span class="font-semibold text-slate-700">CAL:</span> ${escapeHtml(g.cal || '-')}</p>
          <p><span class="font-semibold text-slate-700">Enlace:</span> ${escapeHtml(g.enlace || '-')}</p>
          <p><span class="font-semibold text-slate-700">Resp. CAL:</span> ${escapeHtml(g.respCal || '-')}</p>
        </div>
        <div class="pt-2 border-t border-slate-100 flex justify-end">
          <button
            type="button"
            data-planilla-cod="${escapeHtml(g.codigo === 'SIN CÓDIGO' ? '' : g.codigo)}"
            class="btn-ver-planilla cursor-pointer px-3 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-[#2563EB] text-xs font-semibold transition-colors"
          >
            Ver integrantes
          </button>
        </div>
      </div>`
    )
    .join('');
}

export function renderizarDirectorio() {
  const todosFiltrados = STATE.ultimoListado;
  const esAdmin = STATE.user?.rol === 'admin';
  const puedeEditar = STATE.user?.rol !== 'consulta';

  if (STATE.vistaDirectorio === 'planillas') {
    renderizarVistaPlanillas(todosFiltrados);
    actualizarBarraAccionesBloque();
    return;
  }

  const total = todosFiltrados.length;
  const sinLimite = STATE.imprimiendoDirectorio || STATE.porPaginaDirectorio === 0;
  const totalPaginas = sinLimite
    ? 1
    : Math.max(1, Math.ceil(total / STATE.porPaginaDirectorio));
  if (STATE.paginaDirectorio > totalPaginas) STATE.paginaDirectorio = totalPaginas;
  if (STATE.paginaDirectorio < 1) STATE.paginaDirectorio = 1;

  const inicio = sinLimite
    ? 0
    : (STATE.paginaDirectorio - 1) * STATE.porPaginaDirectorio;
  const fin = sinLimite
    ? total
    : Math.min(total, inicio + STATE.porPaginaDirectorio);
  const regs = sinLimite ? todosFiltrados : todosFiltrados.slice(inicio, fin);

  actualizarBarraPaginacion(total, inicio, fin, totalPaginas);

  if (STATE.vistaDirectorio === 'tabla') {
    const tbody = $('tabla-activistas-body');
    const colSpan = esAdmin ? 9 : 8;
    if (!regs.length) {
      tbody.innerHTML = `<tr class="dir-row-enter"><td colspan="${colSpan}" class="px-4 py-16 text-center text-slate-500">No se encontraron activistas con los criterios aplicados.</td></tr>`;
    } else {
      tbody.innerHTML = regs
        .map((r, idx) => {
          const wa = normalizarWhatsApp(r.telefono);
          const telHtml = r.telefono
            ? `<div class="flex items-center gap-1.5 font-mono text-slate-700 whitespace-nowrap">
                 <span>${escapeHtml(r.telefono)}</span>
                 ${
                   wa.length >= 10
                     ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer" class="no-print text-emerald-600 hover:text-emerald-700" title="WhatsApp">${_SVG_WA}</a>`
                     : ''
                 }
               </div>`
            : '<span class="text-slate-400">-</span>';

          const chkCol = esAdmin
            ? `<td class="no-print px-2.5 py-3 text-center">
                 <input type="checkbox" class="row-select-chk rounded border-slate-300 text-[#2563EB] cursor-pointer" data-cedula="${escapeHtml(r.cedula)}" ${STATE.selectedCedulas.has(r.cedula) ? 'checked' : ''} />
               </td>`
            : '';

          const rolBadge = r.rol_electoral
            ? `<span class="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[10px] font-semibold">${escapeHtml(r.rol_electoral)}</span>`
            : '';

          return `
            <tr class="hover:bg-blue-50/30 transition-colors" ${idx < 15 ? `style="animation-delay: ${idx * 12}ms"` : ''}>
              ${chkCol}
              <td class="px-3 py-3 font-mono font-semibold text-[#2563EB] whitespace-nowrap">${escapeHtml(r.codigo)}</td>
              <td class="px-3 py-3 font-mono text-slate-700 whitespace-nowrap">${escapeHtml(r.cedula)}</td>
              <td class="px-3 py-3 font-semibold text-slate-800 max-w-[200px] whitespace-normal leading-tight">
                <div>${escapeHtml(r.nombre_apellido)}</div>
                ${rolBadge}
              </td>
              <td class="px-3 py-3">${telHtml}</td>
              <td class="px-3 py-3 max-w-[170px] whitespace-normal leading-tight">
                <div class="font-medium text-slate-800">${escapeHtml(r.municipio)}</div>
                <div class="text-[11px] text-slate-500">${escapeHtml(r.parroquia)}</div>
              </td>
              <td class="px-3 py-3 text-slate-600 max-w-[200px] whitespace-normal leading-tight">
                <div>${escapeHtml(r.centro_votacion || '-')}</div>
                ${r.mesa ? `<div class="text-[10px] text-slate-400 font-mono">Mesa ${escapeHtml(r.mesa)}</div>` : ''}
              </td>
              <td class="px-3 py-3 max-w-[180px] whitespace-normal leading-tight">
                <div class="font-medium text-slate-800">${escapeHtml(r.comite_activismo_local || '-')}</div>
                <div class="text-[11px] text-slate-500">${escapeHtml(r.responsable_cal || r.enlace || '')}</div>
              </td>
              <td class="no-print px-3 py-3 text-right whitespace-nowrap">
                <div class="inline-flex items-center gap-1">
                  <button type="button" data-action="ver" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors">
                    Expediente
                  </button>
                  ${
                    puedeEditar
                      ? `<button type="button" data-action="editar" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-xs font-semibold text-[#2563EB] bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors">Editar</button>`
                      : ''
                  }
                  ${
                    esAdmin
                      ? `<button type="button" data-action="eliminar" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors">Eliminar</button>`
                      : ''
                  }
                </div>
              </td>
            </tr>`;
        })
        .join('');
    }

    const chkAll = $('chk-select-all-visible');
    if (chkAll) {
      chkAll.checked =
        regs.length > 0 && regs.every((r) => STATE.selectedCedulas.has(r.cedula));
    }
  } else if (STATE.vistaDirectorio === 'cards') {
    const cardsBox = $('contenedor-vista-cards');
    if (!regs.length) {
      cardsBox.innerHTML =
        '<div class="dir-row-enter col-span-full bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">No se encontraron activistas con los criterios aplicados.</div>';
    } else {
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
                ${
                  wa.length >= 10
                    ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer" class="p-2 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-100">${_SVG_WA}</a>`
                    : ''
                }
              </div>
              <div class="text-xs space-y-1 border-t border-slate-100 pt-2.5 text-slate-600">
                <p><span class="font-semibold text-slate-700">Territorio:</span> ${escapeHtml(r.municipio)} / ${escapeHtml(r.parroquia)}</p>
                <p class="truncate"><span class="font-semibold text-slate-700">Centro:</span> ${escapeHtml(r.centro_votacion || '-')}</p>
                <p><span class="font-semibold text-slate-700">CAL:</span> ${escapeHtml(r.comite_activismo_local || '-')}</p>
              </div>
              <div class="flex items-center justify-end gap-1.5 pt-2 border-t border-slate-100">
                <button type="button" data-action="ver" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg">Expediente</button>
                ${
                  puedeEditar
                    ? `<button type="button" data-action="editar" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-[11px] font-semibold text-[#2563EB] bg-blue-50 hover:bg-blue-100 rounded-lg">Editar</button>`
                    : ''
                }
                ${
                  esAdmin
                    ? `<button type="button" data-action="eliminar" data-cedula="${escapeHtml(r.cedula)}" class="row-action-btn cursor-pointer px-2.5 py-1 text-[11px] font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg">Eliminar</button>`
                    : ''
                }
              </div>
            </div>`;
        })
        .join('');
    }
  }

  actualizarBarraAccionesBloque();
}

// =========================================================
// DRAWER LATERAL DERECHO
// =========================================================
function toggleDrawerModo(edicion) {
  const puedeEditar = STATE.user?.rol !== 'consulta';
  const editarFinal = edicion && puedeEditar;
  if (editarFinal) {
    $('drawer-title').textContent = 'Editar Datos de Activista';
    $('drawer-view-mode').classList.add('hidden');
    $('drawer-edit-form').classList.remove('hidden');
    $('btn-drawer-switch-edit').classList.add('hidden');
    $('btn-drawer-save').classList.remove('hidden');
  } else {
    $('drawer-title').textContent = 'Expediente de Activista';
    $('drawer-view-mode').classList.remove('hidden');
    $('drawer-edit-form').classList.add('hidden');
    $('btn-drawer-switch-edit').classList.toggle('hidden', !puedeEditar);
    $('btn-drawer-save').classList.add('hidden');
  }
}

export function abrirDrawer(r, iniciarEnEdicion = false) {
  $('drawer-subtitle').textContent = `${r.codigo || '-'} • C.I. ${r.cedula}`;

  const redesList = parsearRedesSociales(r.redes_sociales || '');
  const redesHtml = redesList.length
    ? `<div class="flex flex-wrap gap-1.5 mt-1">${redesList
        .map((it) => {
          const url = construirUrlRedSocial(it.plataforma, it.usuario);
          const contenido = `${
            it.plataforma
              ? `<span class="text-slate-500">${escapeHtml(it.plataforma)}:</span>`
              : ''
          }<span>${escapeHtml(it.usuario)}</span>`;
          if (url) {
            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Abrir perfil / contactar" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] border border-blue-200/80 text-[11px] font-semibold transition-colors">${contenido}</a>`;
          }
          return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 text-[11px] font-semibold">${contenido}</span>`;
        })
        .join('')}</div>`
    : '<p class="text-xs font-semibold text-slate-800 mt-0.5">-</p>';

  const edad = calcularEdad(r.fecha_nacimiento);
  const campos = [
    ['Código Planilla', r.codigo || '-'],
    ['Nombre y Apellido', r.nombre_apellido],
    ['Sexo / Edad', `${r.sexo || '-'}${edad !== null ? ` • ${edad} años` : ''}`],
    ['Teléfono', r.telefono || '-'],
    ['Correo', r.correo || '-'],
    ['Dirección de Habitación', r.direccion || '-'],
    ['Redes Sociales', null, redesHtml],
    ['Municipio', `${r.codigo_municipio} - ${r.municipio}`],
    ['Parroquia', `${r.codigo_parroquia} - ${r.parroquia}`],
    [
      'Centro de Votación / Mesa',
      [
        r.centro_votacion || '-',
        r.mesa ? `Mesa ${r.mesa}` : '',
        r.cod_centro ? `Cód. ${r.cod_centro}` : '',
      ]
        .filter(Boolean)
        .join(' • '),
    ],
    ['Comunidad / Sector', r.comunidad || '-'],
    ['Comité Activismo Local (CAL)', r.comite_activismo_local || '-'],
    ['Dirección del CAL', r.direccion_cal || '-'],
    ['Responsable de CAL', r.responsable_cal || '-'],
    ['Responsable Local', r.responsable_local || '-'],
    ['Responsable de Comunidad', r.responsable_comunidad || '-'],
    ['Responsable Municipal', r.responsable_municipal || '-'],
    ['Enlace', r.enlace || '-'],
    ['Rol Electoral / Verificación', `${r.rol_electoral || 'MILITANTE'} • ${r.estado_contacto || 'POR CONTACTAR'}`],
    [
      'Trazabilidad',
      [
        r.creado_por ? `Creado por: ${r.creado_por}` : '',
        r.actualizado_por ? `Act. por: ${r.actualizado_por}` : '',
      ]
        .filter(Boolean)
        .join(' • ') || '-',
    ],
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
  $('drw-codigo').value = r.codigo || '';
  $('drw-nombre').value = r.nombre_apellido || '';
  $('drw-sexo').value = r.sexo || '';
  $('drw-telefono').value = r.telefono || '';
  const codMun = r.codigo_municipio
    ? String(r.codigo_municipio).padStart(2, '0')
    : '';
  const codPar = r.codigo_parroquia
    ? String(r.codigo_parroquia).padStart(2, '0')
    : '';
  $('drw-municipio').value = codMun;
  poblarParroquiasSelect($('drw-parroquia'), codMun, codPar);
  $('drw-centro').value = r.centro_votacion || '';
  if ($('drw-cod-centro')) $('drw-cod-centro').value = r.cod_centro || '';
  if ($('drw-mesa')) $('drw-mesa').value = r.mesa || '';
  if ($('drw-fecha-nacimiento'))
    $('drw-fecha-nacimiento').value = r.fecha_nacimiento || '';
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
  if ($('drw-rol-electoral'))
    $('drw-rol-electoral').value = r.rol_electoral || '';
  if ($('drw-estado-contacto'))
    $('drw-estado-contacto').value = r.estado_contacto || '';

  toggleDrawerModo(iniciarEnEdicion);
  $('drawer-backdrop').classList.remove('hidden');
  $('drawer-panel').classList.remove('translate-x-full');
  refreshIcons();
}

export function abrirDrawerPorCedula(cedula, iniciarEnEdicion = true) {
  const ced = String(cedula || '').replace(/\D/g, '');
  const reg = STATE.todosActivistas.find((x) => x.cedula === ced);
  if (reg) {
    abrirDrawer(reg, iniciarEnEdicion);
  }
}

export function cerrarDrawer() {
  $('drawer-panel').classList.add('translate-x-full');
  $('drawer-backdrop').classList.add('hidden');
}

// =========================================================
// MODAL REPORTE / PDF (COMPARTIDO DIRECTORIO Y ANALÍTICA)
// =========================================================
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

function prepararMembreteDirectorio() {
  const params = obtenerQueryFiltros();
  const partes = [];
  for (const [k, v] of params.entries()) partes.push(`${k}: ${v}`);
  const resumenFiltros =
    partes.length > 0
      ? `Filtros aplicados: ${partes.join(' | ')}`
      : 'Listado General (Estado Aragua)';

  $('print-fecha').textContent = `Fecha: ${new Date().toLocaleString('es-VE')}`;
  $('print-total').textContent = `Total de registros: ${STATE.ultimoListado.length}`;
  $('print-filtros-resumen').textContent = resumenFiltros;

  const nombreDest = ($('rpt-destinatario-nombre')?.value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
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
}

export function abrirModalReporte(target = 'directorio', resumenExtra = '') {
  STATE.printTarget = target;
  if (target === 'analitica') {
    $('rpt-modal-title').textContent = 'Imprimir Reporte Analítico / PDF';
    $('rpt-conteo-badge').textContent = resumenExtra || 'Analítica Electoral';
    $('rpt-filtros-badge').textContent = 'Gráficas, Cobertura y Porcentajes (%)';
  } else {
    $('rpt-modal-title').textContent = 'Imprimir Reporte / PDF';
    const params = obtenerQueryFiltros();
    const partes = [];
    for (const [k, v] of params.entries()) partes.push(`${k}: ${v}`);
    $('rpt-conteo-badge').textContent = `${STATE.ultimoListado.length} registro(s)`;
    $('rpt-filtros-badge').textContent =
      partes.length > 0 ? partes.join(' • ') : 'Listado General (Estado Aragua)';
  }

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
  $('reporte-modal')?.classList.add('hidden');
}

// =========================================================
// RESUMEN WHATSAPP Y EXPORTACIONES
// =========================================================
async function copiarResumenWhatsApp() {
  const regs = STATE.ultimoListado;
  if (!regs.length) {
    mostrarToast('No hay registros filtrados para resumir.', 'error');
    return;
  }

  const porMun = new Map();
  const cals = new Set();
  const centros = new Set();
  for (const r of regs) {
    const mun = r.municipio || 'Sin especificar';
    porMun.set(mun, (porMun.get(mun) || 0) + 1);
    if (r.comite_activismo_local) cals.add(r.comite_activismo_local);
    if (r.centro_votacion) centros.add(r.centro_votacion);
  }
  const topMun = Array.from(porMun.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const lineas = [
    `*AVANZADA PROGRESISTA ARAGUA — REPORTE CAL*`,
    `Fecha: ${new Date().toLocaleDateString('es-VE')}`,
    `• Total activistas: *${regs.length}*`,
    `• Municipios cubiertos: *${porMun.size} / 18*`,
    `• Comités CAL: *${cals.size}*`,
    `• Centros de votación: *${centros.size}*`,
    '',
    '*Desglose por Municipio:*',
    ...topMun.map(([m, c]) => {
      const pct = ((c * 100) / regs.length).toFixed(1);
      return `- ${m}: ${c} (${pct}%)`;
    }),
  ];
  if (porMun.size > 6) {
    lineas.push(`_...y ${porMun.size - 6} municipio(s) adicional(es)._`);
  }

  const texto = lineas.join('\n');
  try {
    await navigator.clipboard.writeText(texto);
    mostrarToast('Resumen copiado para pegar en WhatsApp.', 'ok');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = texto;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    mostrarToast('Resumen copiado para pegar en WhatsApp.', 'ok');
  }
}

function abrirModalBulkEdit() {
  if (!STATE.selectedCedulas.size) return;
  $('bulk-edit-form')?.reset();
  $('bulk-edit-subtitle').textContent = `Aplicar cambios a ${STATE.selectedCedulas.size} activista(s) seleccionados`;
  $('bulk-edit-modal').classList.remove('hidden');
  retriggerAnim($('bulk-edit-modal-card'), 'animate-toast-in');
}

function cerrarModalBulkEdit() {
  $('bulk-edit-modal')?.classList.add('hidden');
}

export function initDirectorio() {
  try {
    const savedDest = localStorage.getItem('ap_rpt_nombre') || '';
    if (savedDest && $('rpt-destinatario-nombre')) {
      $('rpt-destinatario-nombre').value = savedDest;
    }
  } catch (_) {}

  // Chips municipios (delegación)
  $('municipios-chips-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.mun-chip');
    if (!btn) return;
    const cm = btn.dataset.chipMun;
    $('flt-municipio').value = cm;
    poblarParroquiasSelect(
      $('flt-parroquia'),
      cm,
      '',
      'Todas las Parroquias',
      true
    );
    renderizarChipsMunicipios();
    aplicarFiltrosEnMemoria(true);
  });

  // Selectores filtros municipio/parroquia
  $('flt-municipio')?.addEventListener('change', (e) => {
    poblarParroquiasSelect(
      $('flt-parroquia'),
      e.target.value,
      '',
      'Todas las Parroquias',
      true
    );
    renderizarChipsMunicipios();
    aplicarFiltrosEnMemoria(true);
  });
  $('flt-parroquia')?.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.dataset && opt.dataset.mun && !$('flt-municipio').value) {
      const codMun = opt.dataset.mun;
      const codPar = opt.value;
      $('flt-municipio').value = codMun;
      poblarParroquiasSelect(
        $('flt-parroquia'),
        codMun,
        codPar,
        'Todas las Parroquias',
        true
      );
      renderizarChipsMunicipios();
    }
    aplicarFiltrosEnMemoria(true);
  });
  $('drw-municipio')?.addEventListener('change', (e) => {
    poblarParroquiasSelect($('drw-parroquia'), e.target.value);
  });
  $('drw-codigo')?.addEventListener('blur', () => {
    const norm = normalizarInputCodigoPlanilla(
      $('drw-codigo').value,
      $('drw-municipio').value || '01'
    );
    if (norm) $('drw-codigo').value = norm;
  });

  // Conmutadores de vista
  $('view-mode-tabla')?.addEventListener('click', () =>
    setVistaDirectorio('tabla')
  );
  $('view-mode-cards')?.addEventListener('click', () =>
    setVistaDirectorio('cards')
  );
  $('view-mode-planillas')?.addEventListener('click', () =>
    setVistaDirectorio('planillas')
  );

  // Limpiar filtros
  $('btn-limpiar-filtros')?.addEventListener('click', () => {
    limpiarFiltrosDirectorioSoloInputs();
    renderizarChipsMunicipios();
    aplicarFiltrosEnMemoria(true);
  });

  // Filtros con debounce 150ms
  [
    'flt-cedula',
    'flt-codigo',
    'flt-centro',
    'flt-cal',
    'flt-comunidad',
    'flt-resp-comunidad',
    'flt-enlace',
    'flt-resp-cal',
    'flt-resp-local',
    'flt-resp-municipal',
  ].forEach((id) => {
    $(id)?.addEventListener('input', () => {
      clearTimeout(_filtroDebounceTimer);
      _filtroDebounceTimer = setTimeout(() => aplicarFiltrosEnMemoria(true), 150);
    });
    $(id)?.addEventListener('change', () => aplicarFiltrosEnMemoria(true));
  });
  ['flt-rol-electoral', 'flt-estado-contacto'].forEach((id) => {
    $(id)?.addEventListener('change', () => aplicarFiltrosEnMemoria(true));
  });

  // Ordenamiento
  document.querySelectorAll('.dir-sort-th').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sortCol;
      if (!col) return;
      if (STATE.sortCol === col) {
        STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sortCol = col;
        STATE.sortDir = 'asc';
      }
      aplicarFiltrosEnMemoria(true);
    });
  });
  actualizarIndicadoresOrden();

  // Paginación
  $('paginacion-size')?.addEventListener('change', (e) => {
    STATE.porPaginaDirectorio = Number(e.target.value) || 0;
    STATE.paginaDirectorio = 1;
    renderizarDirectorio();
  });
  $('btn-pag-prev')?.addEventListener('click', () => {
    if (STATE.paginaDirectorio > 1) {
      STATE.paginaDirectorio -= 1;
      renderizarDirectorio();
    }
  });
  $('btn-pag-next')?.addEventListener('click', () => {
    const totalPaginas =
      STATE.porPaginaDirectorio === 0
        ? 1
        : Math.max(
            1,
            Math.ceil(STATE.ultimoListado.length / STATE.porPaginaDirectorio)
          );
    if (STATE.paginaDirectorio < totalPaginas) {
      STATE.paginaDirectorio += 1;
      renderizarDirectorio();
    }
  });

  // Delegación de eventos en Tabla, Cards y Planillas
  const manejarAccionFila = async (e) => {
    const chk = e.target.closest('.row-select-chk');
    if (chk) {
      const ced = chk.dataset.cedula;
      if (chk.checked) STATE.selectedCedulas.add(ced);
      else STATE.selectedCedulas.delete(ced);
      actualizarBarraAccionesBloque();
      return;
    }

    const btnPlanilla = e.target.closest('.btn-ver-planilla');
    if (btnPlanilla) {
      const cod = btnPlanilla.dataset.planillaCod || '';
      $('flt-codigo').value = cod;
      setVistaDirectorio('tabla');
      aplicarFiltrosEnMemoria(true);
      return;
    }

    const btn = e.target.closest('.row-action-btn');
    if (!btn) return;
    const ced = btn.dataset.cedula;
    const action = btn.dataset.action;
    const reg = STATE.ultimoListado.find((x) => x.cedula === ced);
    if (!reg) return;

    if (action === 'ver') {
      abrirDrawer(reg, false);
    } else if (action === 'editar') {
      abrirDrawer(reg, true);
    } else if (action === 'eliminar') {
      const confirmado = await pedirConfirmacion({
        titulo: 'Eliminar activista',
        mensaje: `¿Seguro que desea eliminar permanentemente a ${reg.nombre_apellido} (C.I. ${ced})?\n\nEsta acción eliminará su registro del directorio.`,
        textoConfirmar: 'Sí, eliminar',
        variante: 'danger',
      });
      if (!confirmado) return;
      try {
        await apiFetch(`/api/activistas/${encodeURIComponent(ced)}`, {
          method: 'DELETE',
        });
        STATE.cneCache.delete(ced);
        removerActivistaEnMemoria(ced);
        mostrarToast(`Activista ${ced} eliminado.`, 'ok');
        await STATE.callbacks.onDataChanged?.({ reloadEstructura: false });
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    }
  };

  $('tabla-activistas-body')?.addEventListener('click', manejarAccionFila);
  $('contenedor-vista-cards')?.addEventListener('click', manejarAccionFila);
  $('contenedor-vista-planillas')?.addEventListener('click', manejarAccionFila);

  // Seleccionar visibles en tabla
  $('chk-select-all-visible')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    $('tabla-activistas-body')
      .querySelectorAll('.row-select-chk')
      .forEach((chk) => {
        chk.checked = checked;
        if (checked) STATE.selectedCedulas.add(chk.dataset.cedula);
        else STATE.selectedCedulas.delete(chk.dataset.cedula);
      });
    actualizarBarraAccionesBloque();
  });

  // Acciones en bloque
  $('btn-bulk-clear')?.addEventListener('click', () => {
    STATE.selectedCedulas.clear();
    renderizarDirectorio();
  });
  $('btn-bulk-edit')?.addEventListener('click', abrirModalBulkEdit);
  $('btn-cerrar-bulk-edit')?.addEventListener('click', cerrarModalBulkEdit);
  $('btn-cancelar-bulk-edit')?.addEventListener('click', cerrarModalBulkEdit);
  $('bulk-edit-modal-backdrop')?.addEventListener('click', cerrarModalBulkEdit);

  $('bulk-edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cedulas = Array.from(STATE.selectedCedulas);
    if (!cedulas.length) return;

    const payload = { cedulas };
    const mapCampos = {
      codigo: $('blk-codigo').value.trim(),
      comunidad: $('blk-comunidad').value.trim(),
      comite_activismo_local: $('blk-cal').value.trim(),
      direccion_cal: $('blk-direccion-cal').value.trim(),
      enlace: $('blk-enlace').value.trim(),
      responsable_cal: $('blk-resp-cal').value.trim(),
      responsable_local: $('blk-resp-local').value.trim(),
      responsable_comunidad: $('blk-resp-comunidad').value.trim(),
      responsable_municipal: $('blk-resp-municipal').value.trim(),
      rol_electoral: $('blk-rol-electoral').value.trim(),
      estado_contacto: $('blk-estado-contacto').value.trim(),
    };
    let hayCambios = false;
    for (const [k, v] of Object.entries(mapCampos)) {
      if (v) {
        payload[k] = v;
        hayCambios = true;
      }
    }
    if (!hayCambios) {
      mostrarToast('Complete al menos un campo para aplicar en bloque.', 'error');
      return;
    }

    await withButtonLoading($('btn-bulk-edit-save'), async () => {
      try {
        const res = await apiFetch('/api/activistas/bulk-update', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        (data.activistas || []).forEach((a) => {
          STATE.cneCache.delete(a.cedula);
          upsertActivistaEnMemoria(a);
        });
        STATE.selectedCedulas.clear();
        cerrarModalBulkEdit();
        mostrarToast(
          `${data.actualizados} activista(s) actualizados en bloque.`,
          'ok'
        );
        await STATE.callbacks.onDataChanged?.({ reloadEstructura: true });
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  $('btn-bulk-delete')?.addEventListener('click', async () => {
    const cedulas = Array.from(STATE.selectedCedulas);
    if (!cedulas.length) return;
    const ok = await pedirConfirmacion({
      titulo: 'Eliminar activistas seleccionados',
      mensaje: `Se eliminarán permanentemente ${cedulas.length} activista(s) seleccionados. Antes se guardará un respaldo automático de seguridad.\n\n¿Desea continuar?`,
      textoConfirmar: `Eliminar ${cedulas.length}`,
      variante: 'danger',
    });
    if (!ok) return;

    await withButtonLoading($('btn-bulk-delete'), async () => {
      try {
        const res = await apiFetch('/api/activistas/bulk-delete', {
          method: 'POST',
          body: JSON.stringify({ cedulas }),
        });
        const data = await res.json();
        cedulas.forEach((c) => {
          STATE.cneCache.delete(c);
          removerActivistaEnMemoria(c);
        });
        mostrarToast(`${data.eliminados} activista(s) eliminados.`, 'ok');
        await STATE.callbacks.onDataChanged?.({ reloadEstructura: false });
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  // Drawer eventos
  $('btn-cerrar-drawer')?.addEventListener('click', cerrarDrawer);
  $('drawer-backdrop')?.addEventListener('click', cerrarDrawer);
  $('btn-drawer-switch-edit')?.addEventListener('click', () =>
    toggleDrawerModo(true)
  );
  $('btn-add-drw-red')?.addEventListener('click', () => {
    crearFilaRedSocial($('drw-redes-list'), '', '', true);
  });

  $('drawer-edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const codNorm = normalizarInputCodigoPlanilla(
      $('drw-codigo').value,
      $('drw-municipio').value || '01'
    );
    $('drw-codigo').value = codNorm;

    const payload = {
      cedula: $('drw-cedula').value,
      codigo: codNorm,
      nombre_apellido: $('drw-nombre').value,
      sexo: $('drw-sexo').value,
      telefono: $('drw-telefono').value,
      codigo_municipio: $('drw-municipio').value,
      codigo_parroquia: $('drw-parroquia').value,
      centro_votacion: $('drw-centro').value,
      cod_centro: $('drw-cod-centro')?.value || '',
      mesa: $('drw-mesa')?.value || '',
      fecha_nacimiento: $('drw-fecha-nacimiento')?.value || '',
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
      rol_electoral: $('drw-rol-electoral')?.value || '',
      estado_contacto: $('drw-estado-contacto')?.value || '',
    };

    await withButtonLoading($('btn-drawer-save'), async () => {
      try {
        const res = await apiFetch('/api/activistas', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        STATE.cneCache.delete(data.activista.cedula);
        upsertActivistaEnMemoria(data.activista);
        cerrarDrawer();
        mostrarToast('Expediente actualizado correctamente.', 'ok');
        await STATE.callbacks.onDataChanged?.({ reloadEstructura: true });
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  // Comboboxes de Drawer, Filtro CAL y Bulk Edit
  [
    ['drw-enlace', 'enlace', () => $('drw-municipio').value],
    ['drw-resp-local', 'responsable_local', () => $('drw-municipio').value],
    ['drw-resp-comunidad', 'responsable_comunidad', () => $('drw-municipio').value],
    ['drw-resp-municipal', 'responsable_municipal', () => $('drw-municipio').value],
    ['drw-resp-cal', 'responsable_cal', () => $('drw-municipio').value],
    ['blk-enlace', 'enlace', () => ''],
    ['blk-resp-local', 'responsable_local', () => ''],
    ['blk-resp-comunidad', 'responsable_comunidad', () => ''],
    ['blk-resp-municipal', 'responsable_municipal', () => ''],
    ['blk-resp-cal', 'responsable_cal', () => ''],
  ].forEach(([id, rol, getMun]) => {
    crearCombobox($(id), { tipo: 'estructura', rol, getMunCode: getMun });
  });

  [
    ['drw-comunidad', 'comunidad', () => $('drw-municipio').value, () => $('drw-parroquia').value, true],
    ['drw-cal', 'comite_activismo_local', () => $('drw-municipio').value, () => $('drw-parroquia').value, true],
    ['flt-cal', 'comite_activismo_local', () => $('flt-municipio').value, () => $('flt-parroquia').value, true],
    ['blk-cal', 'comite_activismo_local', () => '', () => '', true],
    ['blk-comunidad', 'comunidad', () => '', () => '', true],
  ].forEach(([id, campoKey, getMun, getPar, upper]) => {
    crearCombobox($(id), {
      tipo: 'activista',
      campoKey,
      getMunCode: getMun,
      getParCode: getPar,
      forzarMayusculas: upper,
    });
  });

  crearCombobox($('drw-centro'), {
    tipo: 'centros_cne',
    getMunCode: () => $('drw-municipio').value,
    getParCode: () => $('drw-parroquia').value,
    forzarMayusculas: false,
    onSelect: (centro) => {
      if ($('drw-cod-centro')) $('drw-cod-centro').value = centro.cod_centro || '';
    },
  });

  // Exportaciones y Copiar WhatsApp
  $('btn-exportar-csv')?.addEventListener('click', async () => {
    const params = obtenerQueryFiltros();
    const qs = params.toString();
    const url = qs
      ? `/api/activistas/exportar-csv?${qs}`
      : '/api/activistas/exportar-csv';
    await withButtonLoading($('btn-exportar-csv'), async () => {
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
  });

  $('btn-exportar-xlsx')?.addEventListener('click', async () => {
    const params = obtenerQueryFiltros();
    const dest = ($('rpt-destinatario-nombre')?.value || '').trim();
    if (dest) params.set('destinatario', dest);
    const qs = params.toString();
    const url = qs
      ? `/api/activistas/exportar-xlsx?${qs}`
      : '/api/activistas/exportar-xlsx';
    await withButtonLoading($('btn-exportar-xlsx'), async () => {
      try {
        const res = await apiFetch(url);
        const blob = await res.blob();
        const hoy = new Date().toISOString().slice(0, 10);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `activistas_ap_aragua_${hoy}.xlsx`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        mostrarToast('Libro Excel (.xlsx) descargado con resumen y cobertura.', 'ok');
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  $('btn-copiar-whatsapp')?.addEventListener('click', copiarResumenWhatsApp);

  // Modal Impresión / Reporte PDF
  $('btn-imprimir')?.addEventListener('click', () =>
    abrirModalReporte('directorio')
  );
  $('btn-cerrar-modal-reporte')?.addEventListener('click', cerrarModalReporte);
  $('btn-cancelar-modal-reporte')?.addEventListener('click', cerrarModalReporte);
  $('reporte-modal-backdrop')?.addEventListener('click', cerrarModalReporte);

  $('btn-toggle-personalizar-rpt')?.addEventListener('click', () => {
    $('rpt-personalizar-panel').classList.toggle('hidden');
    actualizarUIPersonalizacionReporte(false);
    if (!$('rpt-personalizar-panel').classList.contains('hidden')) {
      setTimeout(() => $('rpt-destinatario-nombre').focus(), 40);
    }
  });
  $('rpt-destinatario-nombre')?.addEventListener('input', () => {
    actualizarUIPersonalizacionReporte(false);
  });

  $('rpt-destinatario-logo-input')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      mostrarToast(
        'Seleccione una imagen PNG, JPG o WEBP válida (SVG no permitido).',
        'error'
      );
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

  $('btn-quitar-logo-rpt')?.addEventListener('click', () => {
    RPT_LOGO_DATA_URL = '';
    $('rpt-destinatario-logo-input').value = '';
    actualizarUIPersonalizacionReporte(false);
  });

  $('btn-limpiar-personalizar-rpt')?.addEventListener('click', () => {
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

  $('btn-confirmar-imprimir')?.addEventListener('click', () => {
    cerrarModalReporte();
    if (STATE.printTarget === 'analitica') {
      const nombreDest = ($('rpt-destinatario-nombre')?.value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
      STATE.callbacks.onPrintAnalitica?.(nombreDest, RPT_LOGO_DATA_URL);
      return;
    }

    prepararMembreteDirectorio();
    const necesitaExpandir =
      STATE.porPaginaDirectorio !== 0 &&
      STATE.ultimoListado.length > STATE.porPaginaDirectorio;
    if (necesitaExpandir) {
      STATE.imprimiendoDirectorio = true;
      renderizarDirectorio();
    }
    document.body.classList.add('print-mode-directorio');

    const mql = window.matchMedia ? window.matchMedia('print') : null;
    let restored = false;
    const restaurar = () => {
      if (restored) return;
      restored = true;
      document.body.classList.remove('print-mode-directorio');
      if (STATE.imprimiendoDirectorio) {
        STATE.imprimiendoDirectorio = false;
        renderizarDirectorio();
      }
      window.removeEventListener('afterprint', restaurar);
      if (mql && typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', onMqlChange);
      }
    };
    const onMqlChange = (evt) => {
      if (!evt.matches) restaurar();
    };
    window.addEventListener('afterprint', restaurar);
    if (mql && typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onMqlChange);
    }

    setTimeout(() => {
      window.print();
    }, 60);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('reporte-modal') && !$('reporte-modal').classList.contains('hidden')) {
        cerrarModalReporte();
      }
      if ($('bulk-edit-modal') && !$('bulk-edit-modal').classList.contains('hidden')) {
        cerrarModalBulkEdit();
      }
    }
  });
}

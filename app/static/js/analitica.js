import { apiFetch, mostrarToast, withButtonLoading } from './api.js';
import {
  $,
  STATE,
  escapeHtml,
  normalizarFiltroTexto,
  poblarParroquiasSelect,
} from './state.js';

const SOFT_PALETTE = [
  '#3B82F6',
  '#6366F1',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#14B8A6',
  '#60A5FA',
  '#818CF8',
  '#34D399',
  '#FBBF24',
];

let _calidadCategoriaActiva = 'sin_telefono';

function crearODestruirChart(key, canvasId, config) {
  if (STATE.charts[key]) {
    STATE.charts[key].destroy();
    STATE.charts[key] = null;
  }
  const canvas = $(canvasId);
  if (!canvas || !window.Chart) return;
  const ctx = canvas.getContext('2d');
  STATE.charts[key] = new window.Chart(ctx, config);
}

function renderizarCoberturaUI(cob) {
  STATE.coberturaCache = cob;
  if (!cob) return;

  if ($('cob-centros-ratio')) {
    $('cob-centros-ratio').textContent = `${cob.centros_cubiertos || 0} / ${cob.total_centros_cne || 0}`;
  }
  if ($('cob-centros-pct')) {
    $('cob-centros-pct').textContent = `${cob.porcentaje_cobertura || 0}%`;
  }
  if ($('cob-electores-pct')) {
    $('cob-electores-pct').textContent = `${cob.porcentaje_electores_cubiertos || 0}%`;
  }
  if ($('cob-sin-cobertura-cnt')) {
    $('cob-sin-cobertura-cnt').textContent = `${cob.centros_sin_cobertura || 0}`;
  }

  renderizarTablaSinCobertura();
}

function renderizarTablaSinCobertura() {
  const tbody = $('cob-sin-cobertura-body');
  if (!tbody || !STATE.coberturaCache) return;

  const q = normalizarFiltroTexto($('cob-buscar-centro')?.value || '');
  let lista = STATE.coberturaCache.lista_sin_cobertura || [];
  if (q) {
    lista = lista.filter((c) =>
      normalizarFiltroTexto(
        `${c.cod_centro} ${c.centro_votacion} ${c.municipio} ${c.parroquia}`
      ).includes(q)
    );
  }

  if (!lista.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-500">No hay centros sin cobertura para este filtro.</td></tr>';
    return;
  }

  tbody.innerHTML = lista
    .slice(0, 100)
    .map(
      (c) => `
      <tr class="hover:bg-slate-50/80">
        <td class="px-3 py-2 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(c.cod_centro || '—')}</td>
        <td class="px-3 py-2 font-semibold text-slate-800">${escapeHtml(c.centro_votacion)}</td>
        <td class="px-3 py-2 text-slate-600 whitespace-nowrap">${escapeHtml(c.municipio)}</td>
        <td class="px-3 py-2 text-slate-600 whitespace-nowrap">${escapeHtml(c.parroquia)}</td>
        <td class="px-3 py-2 text-right font-mono font-semibold text-slate-700">${Number(c.electores_padron || 0).toLocaleString('es-VE')}</td>
      </tr>`
    )
    .join('');
}

function renderizarCalidadUI(calidad) {
  STATE.calidadCache = calidad;
  if (!calidad) return;

  const scoreEl = $('calidad-score-badge');
  if (scoreEl) {
    const sc = Number(calidad.score_completitud ?? 100);
    scoreEl.textContent = `Completitud: ${sc}%`;
    scoreEl.className = `px-3 py-1 rounded-full text-xs font-mono font-bold border ${
      sc >= 85
        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
        : sc >= 60
        ? 'bg-amber-50 text-amber-800 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200'
    }`;
  }

  const res = calidad.resumen || {};
  const categorias = [
    { key: 'sin_telefono', label: 'Sin teléfono', count: res.sin_telefono || 0 },
    {
      key: 'telefonos_duplicados',
      label: 'Teléfonos duplicados',
      count: res.telefonos_duplicados || 0,
    },
    {
      key: 'sin_centro_votacion',
      label: 'Sin centro CNE',
      count: res.sin_centro_votacion || 0,
    },
    { key: 'sin_cal', label: 'Sin CAL', count: res.sin_cal || 0 },
    {
      key: 'sin_responsable_cal',
      label: 'Sin Resp. CAL',
      count: res.sin_responsable_cal || 0,
    },
    {
      key: 'votan_en_otro_municipio',
      label: 'Otro municipio CNE',
      count: res.votan_en_otro_municipio || 0,
    },
  ];

  const pillsEl = $('calidad-pills');
  if (pillsEl) {
    pillsEl.innerHTML = categorias
      .map((cat) => {
        const active = _calidadCategoriaActiva === cat.key;
        return `
          <button
            type="button"
            data-calidad-cat="${escapeHtml(cat.key)}"
            class="cursor-pointer px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              active
                ? 'bg-[#2563EB] text-white border-[#2563EB]'
                : cat.count > 0
                ? 'bg-amber-50/70 text-amber-800 border-amber-200 hover:bg-amber-100'
                : 'bg-[#F8FAFC] text-slate-600 border-slate-200 hover:bg-slate-100'
            }"
          >
            ${escapeHtml(cat.label)} (${cat.count})
          </button>`;
      })
      .join('');
  }

  renderizarDetalleCalidad();
}

function renderizarDetalleCalidad() {
  const box = $('calidad-detalle-list');
  if (!box || !STATE.calidadCache) return;

  const detalles = STATE.calidadCache.detalles || {};
  const items = detalles[_calidadCategoriaActiva] || [];

  if (!items.length) {
    box.innerHTML =
      '<p class="text-xs text-emerald-700 bg-emerald-50/70 border border-emerald-200 rounded-xl px-4 py-4 text-center font-medium">Sin incidencias detectadas en esta categoría.</p>';
    return;
  }

  if (_calidadCategoriaActiva === 'telefonos_duplicados') {
    box.innerHTML = items
      .map(
        (grp) => `
        <div class="bg-[#F8FAFC] border border-slate-200 rounded-xl p-3 space-y-1.5">
          <div class="flex items-center justify-between text-xs">
            <span class="font-mono font-bold text-amber-800">${escapeHtml(grp.telefono)}</span>
            <span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">${grp.cantidad} fichas</span>
          </div>
          <div class="flex flex-wrap gap-1.5">
            ${(grp.activistas || [])
              .map(
                (a) => `
                <button
                  type="button"
                  data-calidad-ced="${escapeHtml(a.cedula)}"
                  class="cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-slate-200 hover:border-blue-300 text-[11px] font-medium text-slate-700"
                >
                  <span>${escapeHtml(a.nombre_apellido)}</span>
                  <span class="font-mono text-[#2563EB]">(${escapeHtml(a.cedula)})</span>
                </button>`
              )
              .join('')}
          </div>
        </div>`
      )
      .join('');
    return;
  }

  const esAdminOrTranscriptor = STATE.user?.rol !== 'consulta';
  box.innerHTML = items
    .map(
      (a) => `
      <div class="flex items-center justify-between gap-3 bg-[#F8FAFC] border border-slate-200/80 rounded-xl px-3.5 py-2.5 text-xs">
        <div class="min-w-0">
          <p class="font-semibold text-slate-800 truncate">${escapeHtml(a.nombre_apellido)}</p>
          <p class="text-[11px] text-slate-500 font-mono">
            C.I. ${escapeHtml(a.cedula)} • ${escapeHtml(a.codigo || '-')} • ${escapeHtml(a.municipio || '-')}
            ${a.municipio_planilla ? ` (Planilla Mun. ${escapeHtml(a.municipio_planilla)})` : ''}
          </p>
        </div>
        <button
          type="button"
          data-calidad-ced="${escapeHtml(a.cedula)}"
          class="cursor-pointer shrink-0 px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] font-semibold text-[11px]"
        >
          ${esAdminOrTranscriptor ? 'Corregir' : 'Ver'}
        </button>
      </div>`
    )
    .join('');
}

export async function renderizarAnalitica() {
  if (STATE.user?.rol === 'transcriptor') return;

  const todos = STATE.todosActivistas;
  const totalGlobal = todos.length;
  const codMunSel = $('stats-flt-municipio').value;
  const codParSel = $('stats-flt-parroquia').value;

  // Tablero Territorial de los 18 Municipios (siempre muestra universo estatal)
  const conteoMun = new Map();
  for (const r of todos) {
    const cm = String(r.codigo_municipio || '').padStart(2, '0');
    conteoMun.set(cm, (conteoMun.get(cm) || 0) + 1);
  }

  const matrizEl = $('matriz-18-municipios');
  matrizEl.innerHTML = STATE.catalogo
    .map((m) => {
      const cnt = conteoMun.get(m.codigo) || 0;
      const pct = totalGlobal
        ? Number(((cnt * 100) / totalGlobal).toFixed(1))
        : 0;
      const isSelected = codMunSel === m.codigo;
      return `
        <button
          type="button"
          data-sala-mun="${escapeHtml(m.codigo)}"
          class="sala-mun-card cursor-pointer text-left bg-white rounded-xl border p-3 transition-all hover:border-blue-300 ${
            isSelected
              ? 'border-[#2563EB] ring-2 ring-blue-500/15 bg-blue-50/40'
              : 'border-slate-200'
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

  try {
    const qs = new URLSearchParams();
    if (codMunSel) qs.set('codigo_municipio', codMunSel);
    if (codParSel) qs.set('codigo_parroquia', codParSel);
    const queryStr = qs.toString() ? `?${qs.toString()}` : '';

    const [resStats, resCob, resCal] = await Promise.all([
      apiFetch(`/api/estadisticas${queryStr}`),
      apiFetch(`/api/padron/cobertura${queryStr}`),
      apiFetch('/api/calidad-datos'),
    ]);
    const stats = await resStats.json();
    const cob = await resCob.json();
    const calidad = await resCal.json();

    $('stats-total-universo').textContent = stats.total_registrados || 0;

    const porMunicipio = stats.por_municipio || [];
    const porParroquia = stats.por_parroquia || [];
    const porCentro = stats.por_centro_votacion || [];
    const porComunidad = stats.por_comunidad || [];
    const porRespMun = stats.por_responsable_municipal || [];
    const porRespCal = stats.por_responsable_cal || [];
    const porSexo = stats.por_sexo || [];
    const porEdad = stats.por_rango_etario || [];
    const porRolEl = stats.por_rol_electoral || [];
    const porEstCon = stats.por_estado_contacto || [];

    // 1. Doughnut % Por Municipio
    crearODestruirChart('municipio', 'chart-municipio', {
      type: 'doughnut',
      data: {
        labels: porMunicipio
          .slice(0, 10)
          .map((x) => `${x.etiqueta} (${x.porcentaje}%)`),
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
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        },
      },
    });

    // 2. Horizontal Bar % Por Parroquia y Comunidad
    const topParCom = (porParroquia.length ? porParroquia : porComunidad).slice(0, 8);
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
        labels: topCentros
          .map((x) => `${x.etiqueta} (${x.porcentaje}%)`),
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
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, font: { size: 10 } } },
        },
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
            data: [
              ...topRM.map((x) => x.porcentaje),
              ...topRC.map((x) => x.porcentaje),
            ],
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

    // 5. Demografía (Rango Etario + Sexo badges)
    if ($('stats-sexo-badges')) {
      $('stats-sexo-badges').innerHTML = porSexo
        .map(
          (s) =>
            `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-semibold">${escapeHtml(s.etiqueta)}: ${s.cantidad} (${s.porcentaje}%)</span>`
        )
        .join('');
    }
    crearODestruirChart('demografia', 'chart-demografia', {
      type: 'bar',
      data: {
        labels: porEdad.map((x) => x.etiqueta),
        datasets: [
          {
            label: 'Activistas',
            data: porEdad.map((x) => x.cantidad),
            backgroundColor: '#8B5CF6',
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
      },
    });

    // 6. Operativa (Rol Electoral + Estado Contacto badges)
    if ($('stats-contacto-badges')) {
      $('stats-contacto-badges').innerHTML = porEstCon
        .map(
          (c) =>
            `<span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-semibold">${escapeHtml(c.etiqueta)}: ${c.cantidad} (${c.porcentaje}%)</span>`
        )
        .join('');
    }
    crearODestruirChart('operativa', 'chart-operativa', {
      type: 'doughnut',
      data: {
        labels: porRolEl.map((x) => `${x.etiqueta} (${x.porcentaje}%)`),
        datasets: [
          {
            data: porRolEl.map((x) => x.cantidad),
            backgroundColor: ['#2563EB', '#10B981', '#F59E0B', '#6366F1', '#14B8A6', '#94A3B8'],
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        },
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

    renderizarCoberturaUI(cob);
    renderizarCalidadUI(calidad);
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

function imprimirAnaliticaPDF(nombreDest = '', logoDataUrl = '') {
  const munText =
    $('stats-flt-municipio')?.selectedOptions[0]?.textContent ||
    'Todos los Municipios (Aragua)';
  const parText =
    $('stats-flt-parroquia')?.selectedOptions[0]?.textContent ||
    'Todas las Parroquias';
  const univ = $('stats-total-universo')?.textContent || '0';

  if ($('print-analitica-fecha')) {
    $('print-analitica-fecha').textContent = `Fecha: ${new Date().toLocaleString('es-VE')}`;
  }
  if ($('print-analitica-total')) {
    $('print-analitica-total').textContent = `Universo: ${univ} activista(s)`;
  }
  if ($('print-analitica-filtros')) {
    $('print-analitica-filtros').textContent = `${munText} • ${parText}`;
  }

  const boxDest = $('print-analitica-destinatario-box');
  const imgDest = $('print-analitica-destinatario-logo');
  const txtDest = $('print-analitica-destinatario-nombre');
  if (boxDest && txtDest && imgDest) {
    if (nombreDest || logoDataUrl) {
      boxDest.classList.remove('hidden');
      txtDest.textContent = nombreDest || 'INSTITUCIÓN DESTINATARIA';
      if (logoDataUrl) {
        imgDest.src = logoDataUrl;
        imgDest.classList.remove('hidden');
      } else {
        imgDest.src = '';
        imgDest.classList.add('hidden');
      }
    } else {
      boxDest.classList.add('hidden');
    }
  }

  // Convertir cada canvas Chart.js a imagen temporal para impresión limpia en PDF
  const tempImgs = [];
  const canvasIds = [
    'chart-municipio',
    'chart-parroquia-comunidad',
    'chart-centro',
    'chart-responsables',
    'chart-demografia',
    'chart-operativa',
  ];
  canvasIds.forEach((cid) => {
    const canvas = $(cid);
    if (!canvas || !canvas.parentNode) return;
    try {
      const dataUrl = canvas.toDataURL('image/png', 1.0);
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = cid;
      img.className = 'chart-print-snapshot w-full h-full object-contain';
      canvas.classList.add('hidden');
      canvas.parentNode.appendChild(img);
      tempImgs.push({ canvas, img });
    } catch (_) {}
  });

  document.body.classList.add('print-mode-analitica');

  const mql = window.matchMedia ? window.matchMedia('print') : null;
  let restored = false;
  const restaurar = () => {
    if (restored) return;
    restored = true;
    document.body.classList.remove('print-mode-analitica');
    tempImgs.forEach(({ canvas, img }) => {
      img.remove();
      canvas.classList.remove('hidden');
    });
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
  }, 80);
}

export function initAnalitica() {
  STATE.callbacks.onPrintAnalitica = imprimirAnaliticaPDF;

  $('stats-flt-municipio')?.addEventListener('change', (e) => {
    poblarParroquiasSelect(
      $('stats-flt-parroquia'),
      e.target.value,
      '',
      'Todas las Parroquias',
      false
    );
    renderizarAnalitica();
  });
  $('stats-flt-parroquia')?.addEventListener('change', renderizarAnalitica);

  $('matriz-18-municipios')?.addEventListener('click', (e) => {
    const card = e.target.closest('.sala-mun-card');
    if (!card) return;
    const cm = card.dataset.salaMun;
    const actual = $('stats-flt-municipio').value;
    const nuevo = actual === cm ? '' : cm;
    $('stats-flt-municipio').value = nuevo;
    poblarParroquiasSelect(
      $('stats-flt-parroquia'),
      nuevo,
      '',
      'Todas las Parroquias',
      false
    );
    renderizarAnalitica();
  });

  $('cob-buscar-centro')?.addEventListener('input', renderizarTablaSinCobertura);

  $('btn-exportar-xlsx-cobertura')?.addEventListener('click', async () => {
    const params = new URLSearchParams();
    const mun = $('stats-flt-municipio').value;
    const par = $('stats-flt-parroquia').value;
    if (mun) params.set('codigo_municipio', mun);
    if (par) params.set('codigo_parroquia', par);
    const qs = params.toString();
    const url = qs
      ? `/api/activistas/exportar-xlsx?${qs}`
      : '/api/activistas/exportar-xlsx';
    await withButtonLoading($('btn-exportar-xlsx-cobertura'), async () => {
      try {
        const res = await apiFetch(url);
        const blob = await res.blob();
        const hoy = new Date().toISOString().slice(0, 10);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `analitica_cobertura_ap_aragua_${hoy}.xlsx`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        mostrarToast('Excel analítico con centros sin cobertura descargado.', 'ok');
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  $('calidad-pills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-calidad-cat]');
    if (!btn) return;
    _calidadCategoriaActiva = btn.dataset.calidadCat;
    renderizarCalidadUI(STATE.calidadCache);
  });

  $('calidad-detalle-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-calidad-ced]');
    if (!btn) return;
    const ced = btn.dataset.calidadCed;
    const puedeEditar = STATE.user?.rol !== 'consulta';
    STATE.callbacks.onOpenDrawerByCedula?.(ced, puedeEditar);
  });

  $('btn-imprimir-analitica')?.addEventListener('click', () => {
    const univ = $('stats-total-universo')?.textContent || '0';
    STATE.callbacks.onAbrirModalReporte?.(
      'analitica',
      `${univ} activista(s) analizados`
    );
  });
}

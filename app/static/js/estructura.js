import {
  apiFetch,
  consultarElectorCached,
  mostrarToast,
  pedirConfirmacion,
  withButtonLoading,
} from './api.js';
import { refrescarComboboxes } from './combobox.js';
import {
  $,
  ESTRUCTURA_ROLES,
  STATE,
  escapeHtml,
  normalizarClaveEs,
  normalizarNombreEstructura,
  retriggerAnim,
} from './state.js';

let _ultimaCedulaEstConsultada = '';

function setBadgeCneEstructura(texto = '', estilo = '') {
  const badge = $('est-cne-badge');
  if (!badge) return;
  if (!texto) {
    badge.className = 'hidden text-[10px] font-semibold px-2 py-0.5 rounded-full';
    badge.textContent = '';
    return;
  }
  badge.className = `text-[10px] font-semibold px-2 py-0.5 rounded-full border ${estilo}`;
  badge.textContent = texto;
}

async function consultarCedulaEstructura(forzar = false) {
  const ced = String($('est-cedula')?.value || '').replace(/\D/g, '');
  if (ced.length < 5 || ced.length > 12) {
    setBadgeCneEstructura('');
    _ultimaCedulaEstConsultada = '';
    return;
  }
  if (!forzar && ced === _ultimaCedulaEstConsultada) return;
  _ultimaCedulaEstConsultada = ced;
  $('est-cedula').value = ced;

  try {
    const data = await consultarElectorCached(ced);
    const d = data.datos || {};

    if (data.encontrado_en === 'activistas' || data.encontrado_en === 'padron') {
      if (d.nombre_apellido) {
        $('est-nombre').value = String(d.nombre_apellido).toUpperCase();
      }
      if (d.codigo_municipio) {
        $('est-municipio').value = String(d.codigo_municipio).padStart(2, '0');
      }
      if (d.telefono && !$('est-telefono').value.trim()) {
        $('est-telefono').value = d.telefono;
      }
      if (data.encontrado_en === 'activistas') {
        setBadgeCneEstructura(
          'En Activistas',
          'bg-blue-50 text-[#2563EB] border-blue-200'
        );
      } else {
        setBadgeCneEstructura(
          'Verificado CNE',
          'bg-emerald-50 text-emerald-700 border-emerald-200'
        );
      }
    } else {
      setBadgeCneEstructura(
        'No en padrón',
        'bg-amber-50 text-amber-700 border-amber-200'
      );
    }
  } catch (err) {
    _ultimaCedulaEstConsultada = '';
    setBadgeCneEstructura('');
    if (forzar) mostrarToast(err.message, 'error');
  }
}

function abrirModalEstructura(item = null) {
  const modal = $('estructura-modal');
  const card = $('estructura-modal-card');
  if (!modal) return;
  $('estructura-form').reset();
  $('est-id-anterior').value = item ? item.id : '';
  _ultimaCedulaEstConsultada =
    item && item.cedula ? String(item.cedula) : '';
  setBadgeCneEstructura('');

  if (item) {
    $('est-modal-title').textContent = 'Editar Responsable de Estructura';
    $('btn-guardar-estructura-text').textContent = 'Guardar Cambios';
    $('est-rol').value = item.rol;
    $('est-nombre').value = item.nombre;
    $('est-cedula').value = item.cedula || '';
    $('est-telefono').value = item.telefono || '';
    $('est-municipio').value = item.codigo_municipio || '';
    $('est-codigo-rep').value = item.codigo_representante || '';
  } else {
    $('est-modal-title').textContent =
      'Registrar en Estructura y Responsables';
    $('btn-guardar-estructura-text').textContent = 'Guardar en Estructura';
    if (STATE.estRolFiltro && ESTRUCTURA_ROLES[STATE.estRolFiltro]) {
      $('est-rol').value = STATE.estRolFiltro;
    }
    $('est-codigo-rep').value = '';
  }

  modal.classList.remove('hidden');
  retriggerAnim(card, 'animate-toast-in');
  setTimeout(() => (item ? $('est-nombre') : $('est-cedula')).focus(), 40);
}

function cerrarModalEstructura() {
  const modal = $('estructura-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  $('estructura-form').reset();
  $('est-id-anterior').value = '';
  _ultimaCedulaEstConsultada = '';
  setBadgeCneEstructura('');
}

export function renderizarEstructura() {
  const chipsBox = $('est-role-chips');
  const tbody = $('tabla-estructura-body');
  const resumenEl = $('estructura-resumen');
  if (!chipsBox || !tbody) return;

  const esAdmin = STATE.user?.rol === 'admin';
  const puedeEditar = STATE.user?.rol !== 'consulta';

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

  const q = normalizarClaveEs($('est-buscar')?.value || '');
  const filtrados = STATE.estructura.filter((it) => {
    if (STATE.estRolFiltro && it.rol !== STATE.estRolFiltro) return false;
    if (q) {
      const hay = normalizarClaveEs(
        `${it.nombre} ${it.municipio || ''} ${it.cedula || ''}`
      );
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
      const valKey = normalizarClaveEs(act[meta.campoActivista]);
      if (valKey) {
        const k = `${rol}|${valKey}`;
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
      const vinculos =
        conteoPorRolNombre.get(`${it.rol}|${normalizarClaveEs(it.nombre)}`) || 0;
      const contacto = [it.cedula ? `V-${it.cedula}` : '', it.telefono || '']
        .filter(Boolean)
        .join(' • ');
      const repBadge = it.codigo_representante
        ? `<span class="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-50 text-[#2563EB] border border-blue-200">Rep. ${escapeHtml(it.codigo_representante)}</span>`
        : '';

      return `
        <tr class="hover:bg-slate-50/80">
          <td class="px-4 py-3 font-semibold text-slate-800">${escapeHtml(it.nombre)}${repBadge}</td>
          <td class="px-4 py-3">
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${meta.badge}">
              ${escapeHtml(meta.label)}
            </span>
          </td>
          <td class="px-4 py-3 text-slate-600">${escapeHtml(it.municipio || '—')}</td>
          <td class="px-4 py-3 font-mono text-slate-600">${escapeHtml(contacto || '—')}</td>
          <td class="px-4 py-3 text-center">
            <button
              type="button"
              data-est-filter-rol="${escapeHtml(it.rol)}"
              data-est-filter-nombre="${escapeHtml(it.nombre)}"
              title="Ver activistas vinculados en el Directorio"
              class="est-btn-vinculos cursor-pointer inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-blue-50 hover:bg-blue-100 text-[#2563EB] font-mono font-semibold text-xs transition-colors"
            >
              <span>${vinculos}</span>
            </button>
          </td>
          <td class="px-4 py-3 text-right">
            <div class="inline-flex items-center gap-1.5">
              ${
                puedeEditar
                  ? `<button type="button" data-est-edit="${escapeHtml(it.id)}" class="est-btn-edit cursor-pointer px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] font-semibold text-[11px] transition-colors">Editar</button>`
                  : ''
              }
              ${
                esAdmin
                  ? `<button type="button" data-est-del="${escapeHtml(it.id)}" class="est-btn-del cursor-pointer px-2.5 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold text-[11px] transition-colors">Eliminar</button>`
                  : ''
              }
            </div>
          </td>
        </tr>`;
    })
    .join('');
}

export async function cargarEstructura() {
  try {
    const res = await apiFetch('/api/estructura');
    const data = await res.json();
    STATE.estructura = data.registros || [];
    renderizarEstructura();
    refrescarComboboxes();
  } catch (_) {}
}

export function initEstructura() {
  STATE.callbacks.onEstructuraUpdated = renderizarEstructura;

  $('btn-est-buscar-cne')?.addEventListener('click', () =>
    consultarCedulaEstructura(true)
  );
  $('est-cedula')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      consultarCedulaEstructura(true);
    }
  });
  $('est-cedula')?.addEventListener('blur', () =>
    consultarCedulaEstructura(false)
  );

  $('btn-abrir-modal-estructura')?.addEventListener('click', () =>
    abrirModalEstructura(null)
  );
  $('btn-cerrar-modal-estructura')?.addEventListener('click', cerrarModalEstructura);
  $('btn-cancelar-modal-estructura')?.addEventListener('click', cerrarModalEstructura);
  $('estructura-modal-backdrop')?.addEventListener('click', cerrarModalEstructura);
  $('est-buscar')?.addEventListener('input', renderizarEstructura);

  $('est-role-chips')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.est-rol-chip');
    if (!btn) return;
    STATE.estRolFiltro = btn.dataset.estRol || '';
    renderizarEstructura();
  });

  const ROL_TO_FLT_ID = {
    enlace: 'flt-enlace',
    responsable_local: 'flt-resp-local',
    responsable_comunidad: 'flt-resp-comunidad',
    responsable_municipal: 'flt-resp-municipal',
    responsable_cal: 'flt-resp-cal',
  };

  $('tabla-estructura-body')?.addEventListener('click', async (e) => {
    const btnVinc = e.target.closest('.est-btn-vinculos');
    if (btnVinc) {
      const rol = btnVinc.dataset.estFilterRol || '';
      const nombre = btnVinc.dataset.estFilterNombre || '';
      STATE.callbacks.onFiltrarDirectorioPorEstructura?.(
        ROL_TO_FLT_ID[rol],
        nombre
      );
      return;
    }

    const btnEdit = e.target.closest('.est-btn-edit');
    if (btnEdit) {
      const item = STATE.estructura.find((x) => x.id === btnEdit.dataset.estEdit);
      if (item) abrirModalEstructura(item);
      return;
    }

    const btnDel = e.target.closest('.est-btn-del');
    if (btnDel) {
      const item = STATE.estructura.find((x) => x.id === btnDel.dataset.estDel);
      if (!item) return;

      let vinculos = 0;
      const metaRol = ESTRUCTURA_ROLES[item.rol];
      if (metaRol) {
        const key = normalizarClaveEs(item.nombre);
        vinculos = STATE.todosActivistas.filter(
          (a) => normalizarClaveEs(a[metaRol.campoActivista]) === key
        ).length;
      }

      const rolLabel = metaRol?.label || item.rol;
      const msgExtra =
        vinculos > 0
          ? `\n\nTiene ${vinculos} activista(s) vinculado(s); al eliminarlo se limpiará su referencia automáticamente.`
          : '';
      const confirmado = await pedirConfirmacion({
        titulo: 'Eliminar responsable de estructura',
        mensaje: `¿Eliminar a ${item.nombre} (${rolLabel}) del catálogo de Estructura y Responsables?${msgExtra}`,
        textoConfirmar: 'Sí, eliminar',
        variante: 'danger',
      });
      if (!confirmado) return;

      try {
        const res = await apiFetch(
          `/api/estructura/${encodeURIComponent(item.id)}`,
          { method: 'DELETE' }
        );
        const data = await res.json().catch(() => ({}));
        STATE.estructura = STATE.estructura.filter((x) => x.id !== item.id);
        if (data.activistas_actualizados > 0) {
          STATE.cneCache.clear();
          await STATE.callbacks.onFullReloadActivistas?.();
        }
        renderizarEstructura();
        refrescarComboboxes();
        const msg =
          data.activistas_actualizados > 0
            ? `${item.nombre} eliminado (${data.activistas_actualizados} activista(s) desvinculados).`
            : `${item.nombre} eliminado de estructura.`;
        mostrarToast(msg, 'ok');
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    }
  });

  $('estructura-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idAnterior = $('est-id-anterior').value;
    const payload = {
      id_anterior: idAnterior,
      rol: $('est-rol').value,
      nombre: normalizarNombreEstructura($('est-nombre').value),
      cedula: $('est-cedula').value,
      telefono: $('est-telefono').value,
      codigo_municipio: $('est-municipio').value,
      codigo_representante: $('est-codigo-rep').value,
    };

    await withButtonLoading($('btn-guardar-estructura'), async () => {
      try {
        const res = await apiFetch('/api/estructura', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.item) {
          if (idAnterior && idAnterior !== data.item.id) {
            STATE.estructura = STATE.estructura.filter((x) => x.id !== idAnterior);
          }
          const idx = STATE.estructura.findIndex((x) => x.id === data.item.id);
          if (idx >= 0) STATE.estructura[idx] = data.item;
          else STATE.estructura.push(data.item);
          STATE.estructura.sort((a, b) =>
            (a.rol + '|' + a.nombre).localeCompare(b.rol + '|' + b.nombre)
          );
        }
        cerrarModalEstructura();
        if (data.activistas_actualizados > 0) {
          STATE.cneCache.clear();
          await STATE.callbacks.onFullReloadActivistas?.();
        }
        renderizarEstructura();
        refrescarComboboxes();
        if (data.activistas_actualizados > 0) {
          mostrarToast(
            `${data.item.nombre} actualizado (${data.activistas_actualizados} activista(s) actualizados en cascada).`,
            'ok'
          );
        } else {
          mostrarToast(
            `${data.item.nombre} ${data.creado ? 'registrado' : 'actualizado'} en Estructura y Responsables.`,
            'ok'
          );
        }
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (
      e.key === 'Escape' &&
      $('estructura-modal') &&
      !$('estructura-modal').classList.contains('hidden')
    ) {
      cerrarModalEstructura();
    }
  });
}

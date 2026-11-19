import { apiFetch, mostrarToast } from './api.js';
import {
  ESTRUCTURA_ROLES,
  STATE,
  escapeHtml,
  normalizarClaveEs,
  normalizarFiltroTexto,
  normalizarNombreEstructura,
} from './state.js';

const PENDING_ESTRUCTURA_SAVES = new Set();
const COMBOBOX_REFRESHERS = [];

export function existeEnEstructura(rol, nombre) {
  const key = normalizarClaveEs(nombre);
  if (!key) return false;
  return STATE.estructura.some(
    (it) => it.rol === rol && normalizarClaveEs(it.nombre) === key
  );
}

export function refrescarComboboxes() {
  COMBOBOX_REFRESHERS.forEach((fn) => fn());
}

export async function guardarEstructuraAuto(
  rol,
  rawNombre,
  { codigoMunicipio = '', silent = false } = {}
) {
  const nombre = normalizarNombreEstructura(rawNombre);
  if (!STATE.user || !ESTRUCTURA_ROLES[rol] || nombre.length < 2) return null;
  if (STATE.user.rol === 'consulta') return null;
  if (existeEnEstructura(rol, nombre)) return null;

  const key = `${rol}|${normalizarClaveEs(nombre)}`;
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
      STATE.callbacks.onEstructuraUpdated?.();
      refrescarComboboxes();
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

function obtenerOpcionesEstructura(rol, rawVal, mostrarTodas) {
  const q = normalizarClaveEs(rawVal);
  const delRol = STATE.estructura.filter((it) => it.rol === rol);
  const filtradas =
    mostrarTodas || !q
      ? delRol
      : delRol.filter((it) => normalizarClaveEs(it.nombre).includes(q));

  const items = filtradas.map((it) => {
    const meta = [
      it.codigo_representante ? `Rep. ${it.codigo_representante}` : '',
      it.municipio,
      it.telefono,
    ]
      .filter(Boolean)
      .join(' • ');
    return {
      valor: it.nombre,
      label: it.nombre,
      meta,
      selected: normalizarClaveEs(it.nombre) === q,
      highlightMeta: false,
    };
  });

  const qUpper = normalizarNombreEstructura(rawVal);
  const puedeCrear =
    STATE.user?.rol !== 'consulta' &&
    qUpper.length >= 2 &&
    !existeEnEstructura(rol, qUpper);

  return {
    items,
    createLabel: puedeCrear ? qUpper : '',
    emptyText:
      'Sin registros aún. Escriba un nombre para guardarlo automáticamente.',
  };
}

function obtenerOpcionesCampoActivista(
  campoKey,
  rawVal,
  getMunCode,
  getParCode,
  forzarMayusculas,
  mostrarTodas
) {
  const munSel = String(getMunCode() || '').trim().padStart(2, '0');
  const parSel = String(getParCode() || '').trim().padStart(2, '0');
  const tieneMun = Boolean(getMunCode());
  const tienePar = Boolean(getParCode());
  const mapa = new Map();

  for (const act of STATE.todosActivistas) {
    const raw = String(act[campoKey] || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const val = forzarMayusculas ? raw.toUpperCase() : raw;
    const norm = normalizarFiltroTexto(val);
    if (!norm) continue;

    let entry = mapa.get(norm);
    if (!entry) {
      entry = {
        valor: val,
        norm,
        total: 0,
        matchMun: false,
        matchPar: false,
      };
      mapa.set(norm, entry);
    }
    entry.total += 1;
    const actMun = String(act.codigo_municipio || '').padStart(2, '0');
    const actPar = String(act.codigo_parroquia || '').padStart(2, '0');
    if (tieneMun && actMun === munSel) {
      entry.matchMun = true;
      if (tienePar && actPar === parSel) {
        entry.matchPar = true;
      }
    }
  }

  const q = normalizarFiltroTexto(rawVal);
  let lista = Array.from(mapa.values());
  if (!mostrarTodas && q) {
    lista = lista.filter((it) => it.norm.includes(q));
  }
  lista.sort((a, b) => {
    if (a.matchPar !== b.matchPar) return a.matchPar ? -1 : 1;
    if (a.matchMun !== b.matchMun) return a.matchMun ? -1 : 1;
    if (b.total !== a.total) return b.total - a.total;
    return a.valor.localeCompare(b.valor);
  });

  const items = lista.slice(0, 40).map((it) => {
    const badgeZona = it.matchPar
      ? 'Misma parroquia'
      : it.matchMun
      ? 'Mismo mun.'
      : '';
    const meta = [badgeZona, `${it.total} reg.`].filter(Boolean).join(' • ');
    return {
      valor: it.valor,
      label: it.valor,
      meta,
      selected: it.norm === q,
      highlightMeta: it.matchMun,
    };
  });

  return {
    items,
    createLabel: '',
    emptyText: 'Sin coincidencias previas. Escriba para registrar uno nuevo.',
  };
}

function obtenerOpcionesCentrosCne(rawVal, getMunCode, getParCode, mostrarTodas) {
  const munSel = String(getMunCode() || '').trim().padStart(2, '0');
  const parSel = String(getParCode() || '').trim().padStart(2, '0');
  const tieneMun = Boolean(getMunCode());
  const tienePar = Boolean(getParCode());
  const q = normalizarFiltroTexto(rawVal);

  let fuente = STATE.centrosCne;
  if (!fuente.length) {
    return obtenerOpcionesCampoActivista(
      'centro_votacion',
      rawVal,
      getMunCode,
      getParCode,
      false,
      mostrarTodas
    );
  }

  let lista = fuente.filter((c) => {
    if (tieneMun && c.codigo_municipio !== munSel) return false;
    if (tienePar && c.codigo_parroquia !== parSel) return false;
    if (!mostrarTodas && q) {
      const hay = normalizarFiltroTexto(`${c.cod_centro} ${c.centro_votacion}`);
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Si en la parroquia seleccionada no hay coincidencia exacta con texto buscado, ampliar al municipio
  if (!lista.length && tieneMun && tienePar && q) {
    lista = fuente.filter((c) => {
      if (c.codigo_municipio !== munSel) return false;
      const hay = normalizarFiltroTexto(`${c.cod_centro} ${c.centro_votacion}`);
      return hay.includes(q);
    });
  }

  const items = lista.slice(0, 50).map((c) => {
    const metaParts = [];
    if (c.parroquia && !tienePar) metaParts.push(c.parroquia);
    if (c.cod_centro) metaParts.push(`Cód. ${c.cod_centro}`);
    if (c.electores_padron) metaParts.push(`${Number(c.electores_padron).toLocaleString('es-VE')} elec.`);
    return {
      valor: c.centro_votacion,
      label: c.centro_votacion,
      meta: metaParts.join(' • '),
      selected: normalizarFiltroTexto(c.centro_votacion) === q,
      highlightMeta: Boolean(tieneMun && c.codigo_municipio === munSel),
      payload: c,
    };
  });

  return {
    items,
    createLabel: '',
    emptyText: 'Sin centros CNE coincidentes para esta zona.',
  };
}

/**
 * Componente combobox unificado para Estructura, Campos de Activista y Centros CNE.
 */
export function crearCombobox(inputEl, cfg) {
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
  toggleBtn.setAttribute('aria-label', cfg.ariaLabel || 'Ver opciones');
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
  let ignoreBlur = false;
  let currentItems = [];

  const getDatosMenu = (mostrarTodas) => {
    if (cfg.tipo === 'estructura') {
      return obtenerOpcionesEstructura(cfg.rol, inputEl.value, mostrarTodas);
    }
    if (cfg.tipo === 'centros_cne') {
      return obtenerOpcionesCentrosCne(
        inputEl.value,
        cfg.getMunCode || (() => ''),
        cfg.getParCode || (() => ''),
        mostrarTodas
      );
    }
    return obtenerOpcionesCampoActivista(
      cfg.campoKey,
      inputEl.value,
      cfg.getMunCode || (() => ''),
      cfg.getParCode || (() => ''),
      cfg.forzarMayusculas !== false,
      mostrarTodas
    );
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
    const { items, createLabel, emptyText } = getDatosMenu(mostrarTodas);
    currentItems = items;

    const itemsHtml = items
      .map((it, idx) => {
        const rowClass =
          idx === activeIdx
            ? 'bg-blue-50 text-[#2563EB]'
            : it.selected
            ? 'bg-slate-50 text-[#2563EB] font-semibold'
            : 'text-slate-700 hover:bg-slate-50';
        const metaClass = it.highlightMeta
          ? 'text-emerald-600 font-semibold'
          : 'text-slate-400';
        return `
          <button
            type="button"
            data-combo-idx="${idx}"
            class="combo-opt w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 transition-colors ${rowClass}"
          >
            <span class="font-semibold truncate">${escapeHtml(it.label)}</span>
            ${it.meta ? `<span class="text-[10px] ${metaClass} shrink-0">${escapeHtml(it.meta)}</span>` : ''}
          </button>`;
      })
      .join('');

    const createHtml = createLabel
      ? `
        <button
          type="button"
          data-combo-create="${escapeHtml(createLabel)}"
          data-combo-idx="${items.length}"
          class="combo-opt w-full text-left px-3 py-2 text-xs flex items-center gap-1.5 border-t border-slate-100 text-[#2563EB] font-semibold ${
            activeIdx === items.length ? 'bg-blue-50' : 'bg-blue-50/40 hover:bg-blue-50'
          }"
        >
          <span>+ Guardar “${escapeHtml(createLabel)}” en estructura</span>
        </button>`
      : '';

    if (!itemsHtml && !createHtml) {
      menu.innerHTML = `<p class="px-3 py-2.5 text-[11px] text-slate-400 text-center">${escapeHtml(emptyText)}</p>`;
    } else {
      menu.innerHTML = itemsHtml + createHtml;
    }

    menu.querySelectorAll('.combo-opt').forEach((btn) => {
      btn.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        ignoreBlur = true;
        const createVal = btn.dataset.comboCreate;
        if (createVal) {
          inputEl.value = createVal;
          cerrar();
          if (cfg.tipo === 'estructura') {
            await guardarEstructuraAuto(cfg.rol, createVal, {
              codigoMunicipio: cfg.getMunCode ? cfg.getMunCode() : '',
            });
          }
        } else {
          const item = currentItems[Number(btn.dataset.comboIdx)];
          if (item) {
            inputEl.value = item.valor;
            cerrar();
            if (cfg.onSelect && item.payload) {
              cfg.onSelect(item.payload);
            }
          } else {
            cerrar();
          }
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

  inputEl.addEventListener('keydown', (e) => {
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
      } else if (cfg.tipo === 'estructura' && normalizarNombreEstructura(inputEl.value).length >= 2) {
        e.preventDefault();
        inputEl.value = normalizarNombreEstructura(inputEl.value);
        cerrar();
      }
    } else if (e.key === 'Escape') {
      cerrar();
    }
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(() => {
      cerrar();
      if (ignoreBlur) {
        ignoreBlur = false;
        return;
      }
      if (cfg.tipo === 'estructura') {
        const norm = normalizarNombreEstructura(inputEl.value);
        if (norm.length >= 2) inputEl.value = norm;
      } else if (cfg.forzarMayusculas !== false && inputEl.value.trim()) {
        inputEl.value = inputEl.value.replace(/\s+/g, ' ').trim().toUpperCase();
      }
    }, 130);
  });

  COMBOBOX_REFRESHERS.push(() => {
    if (isOpen) renderMenu(false);
  });
}

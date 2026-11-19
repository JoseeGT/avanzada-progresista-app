import { $, STATE, refreshIcons, retriggerAnim } from './state.js';

export function mostrarToast(mensaje, tipo = 'info') {
  const box = $('toast-box');
  if (!box) return;
  const estilos = {
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  };
  box.className = `no-print fixed bottom-5 right-5 z-[70] max-w-sm px-4 py-3 rounded-xl shadow-md border text-sm font-medium ${estilos[tipo] || estilos.info}`;
  box.textContent = mensaje;
  box.classList.remove('hidden');
  retriggerAnim(box, 'animate-toast-in');
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.classList.add('hidden'), 3800);
}

export function pedirConfirmacion({
  titulo = 'Confirmar acción',
  subtitulo = '',
  mensaje = '',
  textoConfirmar = 'Confirmar',
  variante = 'primary',
  mostrarModoRestore = false,
}) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    const card = $('confirm-modal-card');
    const header = $('confirm-modal-header');
    const subtitleEl = $('confirm-modal-subtitle');
    const iconWrap = $('confirm-modal-icon-wrap');
    const iconEl = $('confirm-modal-icon');
    const acceptBtn = $('btn-confirm-accept');
    const cancelBtn = $('btn-confirm-cancel');
    const backdrop = $('confirm-modal-backdrop');
    const restoreBox = $('confirm-restore-options');
    const prevFocus = document.activeElement;

    $('confirm-modal-title').textContent = titulo;
    $('confirm-modal-message').textContent = mensaje;
    acceptBtn.textContent = textoConfirmar;

    const textoSub =
      subtitulo || (variante === 'danger' ? 'Esta acción no se puede deshacer' : '');
    if (textoSub) {
      subtitleEl.textContent = textoSub;
      subtitleEl.classList.remove('hidden');
    } else {
      subtitleEl.textContent = '';
      subtitleEl.classList.add('hidden');
    }

    if (variante === 'danger') {
      header.className =
        'bg-red-50/75 border-b border-red-200/80 px-6 py-4 flex items-center gap-3';
      subtitleEl.className = 'text-[11px] font-medium text-red-700 mt-0.5';
      iconWrap.className =
        'w-9 h-9 rounded-xl bg-red-100 text-red-600 flex items-center justify-center shrink-0 border border-red-200/80';
      iconEl.setAttribute('data-lucide', 'alert-triangle');
      acceptBtn.className =
        'cursor-pointer px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-xl shadow-sm transition-colors';
    } else {
      header.className =
        'bg-[#F8FAFC] border-b border-slate-200 px-6 py-4 flex items-center gap-3';
      subtitleEl.className = 'text-[11px] font-medium text-slate-500 mt-0.5';
      iconWrap.className =
        'w-9 h-9 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center shrink-0';
      iconEl.setAttribute('data-lucide', 'help-circle');
      acceptBtn.className =
        'cursor-pointer px-4 py-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold rounded-xl shadow-sm transition-colors';
    }

    if (mostrarModoRestore) {
      restoreBox.classList.remove('hidden');
      const defRadio = modal.querySelector('input[name="restore-modo"][value="fusionar"]');
      if (defRadio) defRadio.checked = true;
    } else {
      restoreBox.classList.add('hidden');
    }

    refreshIcons();
    modal.classList.remove('hidden');
    retriggerAnim(card, 'animate-toast-in');
    setTimeout(() => {
      if (variante === 'danger') cancelBtn.focus();
      else acceptBtn.focus();
    }, 30);

    const finalizar = (resultado) => {
      modal.classList.add('hidden');
      acceptBtn.removeEventListener('click', onAccept);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      }
      resolve(resultado);
    };

    const onAccept = () => {
      if (mostrarModoRestore) {
        const sel = modal.querySelector('input[name="restore-modo"]:checked');
        finalizar({ confirmado: true, modo: sel ? sel.value : 'fusionar' });
      } else {
        finalizar(true);
      }
    };

    const onCancel = () =>
      finalizar(mostrarModoRestore ? { confirmado: false, modo: 'fusionar' } : false);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    acceptBtn.addEventListener('click', onAccept);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

export async function apiFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  headers['X-Requested-With'] = 'XMLHttpRequest';

  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(
    url,
    Object.assign({}, options, {
      headers,
      credentials: 'same-origin',
    })
  );

  if (res.status === 401 && !options.skipAuthRedirect) {
    STATE.callbacks.onAuthExpired?.();
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

export async function withButtonLoading(btn, asyncFn, loadingText = '') {
  if (btn && btn.dataset.loading === '1') return;
  const origDisabled = btn ? btn.disabled : false;
  const origHtml = btn ? btn.innerHTML : '';

  if (btn) {
    btn.dataset.loading = '1';
    btn.disabled = true;
    btn.classList.add('opacity-75', 'cursor-wait');
    if (loadingText) {
      btn.textContent = loadingText;
    }
  }
  try {
    return await asyncFn();
  } finally {
    if (btn) {
      delete btn.dataset.loading;
      btn.disabled = origDisabled;
      btn.classList.remove('opacity-75', 'cursor-wait');
      if (loadingText) {
        btn.innerHTML = origHtml;
        refreshIcons();
      }
    }
  }
}

export async function consultarElectorCached(cedula, forzarRefresh = false) {
  const ced = String(cedula || '').replace(/\D/g, '');
  if (!forzarRefresh && STATE.cneCache.has(ced)) {
    return STATE.cneCache.get(ced);
  }
  const res = await apiFetch(`/api/elector/${encodeURIComponent(ced)}`);
  const data = await res.json();
  STATE.cneCache.set(ced, data);
  return data;
}

export async function buscarPadronPorNombre(q, codMun = '', codPar = '', limit = 25) {
  const params = new URLSearchParams({ q: String(q || '').trim(), limit: String(limit) });
  if (codMun) params.set('codigo_municipio', codMun);
  if (codPar) params.set('codigo_parroquia', codPar);
  const res = await apiFetch(`/api/padron/buscar-nombre?${params.toString()}`);
  return res.json();
}

export async function cargarCentrosCne() {
  try {
    const res = await apiFetch('/api/padron/centros?limit=700');
    const data = await res.json();
    STATE.centrosCne = data.registros || [];
  } catch (_) {
    STATE.centrosCne = [];
  }
}

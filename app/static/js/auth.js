import { apiFetch, mostrarToast, pedirConfirmacion, withButtonLoading } from './api.js';
import {
  $,
  BORRADOR_PLANILLA_KEY,
  STATE,
  escapeHtml,
  refreshIcons,
  retriggerAnim,
} from './state.js';

let _idleTimer = null;
let _lastActivityTs = 0;

function limpiarDomSensible() {
  try {
    localStorage.removeItem(BORRADOR_PLANILLA_KEY);
  } catch (_) {}

  const idsReset = [
    'activista-form',
    'planilla-grupal-form',
    'drawer-edit-form',
    'estructura-form',
    'clave-form',
    'usuario-create-form',
  ];
  idsReset.forEach((id) => $(id)?.reset());

  const clearHtml = [
    'grp-filas-body',
    'tabla-activistas-body',
    'contenedor-vista-cards',
    'contenedor-vista-planillas',
    'tabla-estructura-body',
    'drawer-view-mode',
  ];
  clearHtml.forEach((id) => {
    const el = $(id);
    if (el) el.innerHTML = '';
  });

  if ($('topbar-quick-search')) $('topbar-quick-search').value = '';
  if ($('cne-cedula-search')) $('cne-cedula-search').value = '';
  if ($('elector-summary-card')) $('elector-summary-card').classList.add('hidden');
}

export function aplicarPermisosRol() {
  const rol = STATE.user?.rol || 'consulta';

  document.querySelectorAll('[data-roles]').forEach((el) => {
    const allowed = String(el.dataset.roles || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.length || allowed.includes(rol)) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });

  const userLbl = $('sidebar-user-badge');
  if (userLbl && STATE.user) {
    const rolLabels = {
      admin: 'Administrador',
      transcriptor: 'Transcriptor',
      consulta: 'Solo Consulta',
    };
    userLbl.textContent = `${STATE.user.nombre} (${rolLabels[rol] || rol})`;
  }
}

export function mostrarApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  aplicarPermisosRol();
  refreshIcons();
  reiniciarTimerInactividad();
  STATE.callbacks.onShowApp?.();
}

export function cerrarSesionLocal(mensaje = '') {
  detenerTimerInactividad();
  STATE.user = null;
  STATE.todosActivistas = [];
  STATE.ultimoListado = [];
  STATE.activistasCargados = false;
  STATE.estructura = [];
  STATE.selectedCedulas.clear();
  STATE.cneCache.clear();
  STATE.coberturaCache = null;
  STATE.calidadCache = null;

  limpiarDomSensible();

  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  if ($('login-password')) $('login-password').value = '';
  refreshIcons();

  if (mensaje) {
    const errBox = $('login-error');
    if (errBox) {
      errBox.textContent = mensaje;
      errBox.classList.remove('hidden');
    }
  }
}

function reiniciarTimerInactividad() {
  clearTimeout(_idleTimer);
  if (!STATE.user) return;
  const ms = Math.max(60, Number(STATE.idleSeconds) || 3600) * 1000;
  _idleTimer = setTimeout(async () => {
    if (!STATE.user) return;
    try {
      await apiFetch('/api/logout', { method: 'POST', skipAuthRedirect: true });
    } catch (_) {}
    cerrarSesionLocal('Sesión cerrada automáticamente por inactividad.');
  }, ms);
}

function detenerTimerInactividad() {
  clearTimeout(_idleTimer);
  _idleTimer = null;
}

function registrarActividad() {
  if (!STATE.user) return;
  const ahora = Date.now();
  if (ahora - _lastActivityTs < 5000) return;
  _lastActivityTs = ahora;
  reiniciarTimerInactividad();
}

export async function cargarConfigAuth() {
  try {
    const res = await fetch('/api/auth/config', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    STATE.multiUsuario = Boolean(data.multi_usuario);
    if (data.idle_seconds) STATE.idleSeconds = Number(data.idle_seconds);
    const wrap = $('login-username-wrap');
    const toggleBtn = $('btn-toggle-login-user');
    if (wrap && toggleBtn) {
      if (STATE.multiUsuario) {
        wrap.classList.remove('hidden');
        toggleBtn.classList.add('hidden');
      } else {
        wrap.classList.add('hidden');
        toggleBtn.classList.remove('hidden');
      }
    }
  } catch (_) {}
}

export async function intentarReanudarSesion() {
  try {
    const res = await apiFetch('/api/auth/me', { skipAuthRedirect: true });
    const me = await res.json();
    STATE.user = me;
    STATE.multiUsuario = Boolean(me.multi_usuario);
    await STATE.callbacks.onLoginSuccess?.();
    return true;
  } catch (_) {
    return false;
  }
}

function abrirModalClave() {
  $('clave-form')?.reset();
  $('clave-modal').classList.remove('hidden');
  retriggerAnim($('clave-modal-card'), 'animate-toast-in');
  setTimeout(() => $('clave-actual')?.focus(), 40);
}

function cerrarModalClave() {
  $('clave-modal')?.classList.add('hidden');
  $('clave-form')?.reset();
}

async function cargarListaUsuarios() {
  const tbody = $('usuarios-lista-body');
  if (!tbody) return;
  try {
    const res = await apiFetch('/api/usuarios');
    const data = await res.json();
    const regs = data.registros || [];
    const rolBadges = {
      admin: 'bg-blue-50 text-[#2563EB] border-blue-200',
      transcriptor: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      consulta: 'bg-slate-100 text-slate-700 border-slate-200',
    };

    tbody.innerHTML = regs
      .map((u) => {
        const esActual = u.username === STATE.user?.username;
        const badgeRol = rolBadges[u.rol] || rolBadges.consulta;
        const estadoBadge = u.activo
          ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Activo</span>'
          : '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200">Inactivo</span>';
        return `
          <tr class="hover:bg-slate-50/80">
            <td class="px-3 py-2.5">
              <div class="font-semibold text-slate-800">${escapeHtml(u.nombre)}</div>
              <div class="font-mono text-[11px] text-slate-500">@${escapeHtml(u.username)} ${esActual ? '(tú)' : ''}</div>
            </td>
            <td class="px-3 py-2.5">
              <span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeRol}">${escapeHtml(u.rol)}</span>
            </td>
            <td class="px-3 py-2.5">${estadoBadge}</td>
            <td class="px-3 py-2.5 text-right whitespace-nowrap space-x-1">
              ${
                !esActual
                  ? `<button type="button" data-usr-toggle="${escapeHtml(u.username)}" data-usr-activo="${u.activo ? '1' : '0'}" class="cursor-pointer px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold">${u.activo ? 'Desactivar' : 'Activar'}</button>
                     <button type="button" data-usr-del="${escapeHtml(u.username)}" class="cursor-pointer px-2 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 text-[11px] font-semibold">Eliminar</button>`
                  : '<span class="text-[11px] text-slate-400">Sesión actual</span>'
              }
            </td>
          </tr>`;
      })
      .join('');
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

function abrirModalUsuarios() {
  $('usuario-create-form')?.reset();
  $('usuarios-modal').classList.remove('hidden');
  retriggerAnim($('usuarios-modal-card'), 'animate-toast-in');
  cargarListaUsuarios();
}

function cerrarModalUsuarios() {
  $('usuarios-modal')?.classList.add('hidden');
}

export function initAuth() {
  STATE.callbacks.onAuthExpired = () => {
    if (STATE.user) {
      cerrarSesionLocal('Su sesión expiró. Ingrese nuevamente.');
    }
  };

  ['mousemove', 'keydown', 'click', 'scroll'].forEach((evt) => {
    document.addEventListener(evt, registrarActividad, { passive: true });
  });

  $('toggle-password-btn')?.addEventListener('click', () => {
    const input = $('login-password');
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    $('eye-icon').setAttribute('data-lucide', isPass ? 'eye-off' : 'eye');
    refreshIcons();
  });

  $('btn-toggle-login-user')?.addEventListener('click', () => {
    const wrap = $('login-username-wrap');
    if (!wrap) return;
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) {
      $('login-username')?.focus();
    }
  });

  $('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('login-error');
    errBox.classList.add('hidden');
    const username = ($('login-username')?.value || '').trim();
    const password = $('login-password').value;

    await withButtonLoading($('login-submit'), async () => {
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.detail || 'Clave de acceso incorrecta.');
        }
        const data = await res.json();
        STATE.user = data.user || { username: username || 'admin', nombre: 'Administrador', rol: 'admin' };
        await STATE.callbacks.onLoginSuccess?.();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    });
  });

  async function handleLogout() {
    try {
      await apiFetch('/api/logout', { method: 'POST', skipAuthRedirect: true });
    } catch (_) {}
    cerrarSesionLocal();
    cargarConfigAuth();
  }
  $('btn-logout-sidebar')?.addEventListener('click', handleLogout);
  $('btn-logout-topbar')?.addEventListener('click', handleLogout);

  // Modal Cambiar Clave
  $('btn-cambiar-clave')?.addEventListener('click', abrirModalClave);
  $('btn-cerrar-modal-clave')?.addEventListener('click', cerrarModalClave);
  $('btn-cancelar-modal-clave')?.addEventListener('click', cerrarModalClave);
  $('clave-modal-backdrop')?.addEventListener('click', cerrarModalClave);

  $('clave-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const actual = $('clave-actual').value;
    const nueva = $('clave-nueva').value;
    const confirmar = $('clave-confirmar').value;
    if (nueva !== confirmar) {
      mostrarToast('La nueva clave y su confirmación no coinciden.', 'error');
      return;
    }
    await withButtonLoading($('btn-guardar-clave'), async () => {
      try {
        await apiFetch('/api/auth/cambiar-clave', {
          method: 'POST',
          body: JSON.stringify({ password_actual: actual, password_nueva: nueva }),
        });
        cerrarModalClave();
        mostrarToast('Clave de acceso actualizada correctamente.', 'ok');
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  // Modal Gestión de Usuarios (Admin)
  $('btn-gestion-usuarios')?.addEventListener('click', abrirModalUsuarios);
  $('btn-cerrar-modal-usuarios')?.addEventListener('click', cerrarModalUsuarios);
  $('usuarios-modal-backdrop')?.addEventListener('click', cerrarModalUsuarios);

  $('usuario-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      username: $('usr-username').value.trim().toLowerCase(),
      nombre: $('usr-nombre').value.trim(),
      rol: $('usr-rol').value,
      password: $('usr-password').value,
      activo: true,
    };
    await withButtonLoading($('btn-crear-usuario'), async () => {
      try {
        await apiFetch('/api/usuarios', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        $('usuario-create-form').reset();
        mostrarToast(`Usuario @${payload.username} creado.`, 'ok');
        await cargarListaUsuarios();
        cargarConfigAuth();
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  $('usuarios-lista-body')?.addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('[data-usr-toggle]');
    if (toggleBtn) {
      const uname = toggleBtn.dataset.usrToggle;
      const activoActual = toggleBtn.dataset.usrActivo === '1';
      try {
        await apiFetch(`/api/usuarios/${encodeURIComponent(uname)}`, {
          method: 'PUT',
          body: JSON.stringify({ activo: !activoActual }),
        });
        mostrarToast(`Usuario @${uname} ${!activoActual ? 'activado' : 'desactivado'}.`, 'ok');
        await cargarListaUsuarios();
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
      return;
    }

    const delBtn = e.target.closest('[data-usr-del]');
    if (delBtn) {
      const uname = delBtn.dataset.usrDel;
      const ok = await pedirConfirmacion({
        titulo: 'Eliminar usuario',
        mensaje: `¿Seguro que desea eliminar la cuenta @${uname}?`,
        textoConfirmar: 'Sí, eliminar',
        variante: 'danger',
      });
      if (!ok) return;
      try {
        await apiFetch(`/api/usuarios/${encodeURIComponent(uname)}`, { method: 'DELETE' });
        mostrarToast(`Usuario @${uname} eliminado.`, 'ok');
        await cargarListaUsuarios();
        cargarConfigAuth();
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('clave-modal') && !$('clave-modal').classList.contains('hidden')) cerrarModalClave();
      if ($('usuarios-modal') && !$('usuarios-modal').classList.contains('hidden')) cerrarModalUsuarios();
    }
  });
}

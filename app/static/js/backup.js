import {
  apiFetch,
  mostrarToast,
  pedirConfirmacion,
  withButtonLoading,
} from './api.js';
import { $, STATE, escapeHtml, retriggerAnim } from './state.js';

function formatearBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

async function abrirModalBackupsAuto() {
  const modal = $('auto-backups-modal');
  const tbody = $('auto-backups-body');
  if (!modal || !tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="4" class="px-4 py-6 text-center text-slate-500">Cargando copias locales...</td></tr>';
  modal.classList.remove('hidden');
  retriggerAnim($('auto-backups-modal-card'), 'animate-toast-in');

  const motivoLabels = {
    diario: 'Respaldo diario',
    pre_restore: 'Antes de restaurar',
    pre_bulk_delete: 'Antes de borrado masivo',
  };

  try {
    const res = await apiFetch('/api/backups/automaticos');
    const data = await res.json();
    const regs = data.registros || [];
    if (!regs.length) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-500">Aún no se han generado respaldos automáticos. Se crean automáticamente en la primera escritura del día o antes de restaurar/borrar en bloque.</td></tr>';
      return;
    }
    tbody.innerHTML = regs
      .map((b) => {
        const fecha = b.fecha_creacion
          ? new Date(b.fecha_creacion).toLocaleString('es-VE')
          : b.filename;
        return `
          <tr class="hover:bg-slate-50/80">
            <td class="px-3 py-2.5 text-slate-800 font-medium">${escapeHtml(fecha)}</td>
            <td class="px-3 py-2.5">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-[#2563EB] border border-blue-200">${escapeHtml(motivoLabels[b.motivo] || b.motivo)}</span>
            </td>
            <td class="px-3 py-2.5 font-mono text-slate-600">${escapeHtml(formatearBytes(b.size_bytes))}</td>
            <td class="px-3 py-2.5 text-right">
              <button type="button" data-auto-bkp="${escapeHtml(b.filename)}" class="cursor-pointer px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-blue-50 text-[#2563EB] font-semibold text-[11px]">Descargar</button>
            </td>
          </tr>`;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-red-600">${escapeHtml(err.message)}</td></tr>`;
  }
}

function cerrarModalBackupsAuto() {
  $('auto-backups-modal')?.classList.add('hidden');
}

export function initBackup() {
  $('btn-descargar-backup')?.addEventListener('click', async () => {
    await withButtonLoading($('btn-descargar-backup'), async () => {
      try {
        const res = await apiFetch('/api/backup');
        const blob = await res.blob();
        const hoy = new Date().toISOString().slice(0, 10);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `respaldo_ap_aragua_${hoy}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        mostrarToast('Respaldo JSON descargado correctamente.', 'ok');
      } catch (err) {
        mostrarToast(err.message, 'error');
      }
    });
  });

  $('btn-restaurar-backup')?.addEventListener('click', () => {
    $('input-file-backup').value = '';
    $('input-file-backup').click();
  });

  $('input-file-backup')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const texto = await file.text();
      const parsed = JSON.parse(texto);
      const activistas = Array.isArray(parsed.activistas) ? parsed.activistas : [];
      const estructura = Array.isArray(parsed.estructura) ? parsed.estructura : [];
      if (!activistas.length && !estructura.length) {
        mostrarToast(
          'El archivo seleccionado no contiene registros válidos de respaldo.',
          'error'
        );
        return;
      }
      const resConfirm = await pedirConfirmacion({
        titulo: 'Restaurar respaldo JSON',
        mensaje: `El archivo contiene ${activistas.length} activista(s) y ${estructura.length} responsable(s). Se guardará una copia de seguridad previa automáticamente. Seleccione cómo desea restaurarlo:`,
        textoConfirmar: 'Restaurar respaldo',
        variante: 'primary',
        mostrarModoRestore: true,
      });
      if (!resConfirm || !resConfirm.confirmado) return;

      const res = await apiFetch('/api/backup/restore', {
        method: 'POST',
        body: JSON.stringify({
          modo: resConfirm.modo,
          activistas,
          estructura,
        }),
      });
      const data = await res.json();
      STATE.cneCache.clear();
      STATE.selectedCedulas.clear();
      await STATE.callbacks.onRestoreComplete?.();
      mostrarToast(
        `Respaldo restaurado: ${data.total_activistas} activista(s) y ${data.total_estructura} responsable(s) en el sistema.`,
        'ok'
      );
    } catch (err) {
      mostrarToast(
        err.message || 'Error leyendo el archivo de respaldo.',
        'error'
      );
    } finally {
      e.target.value = '';
    }
  });

  $('btn-ver-backups-auto')?.addEventListener('click', abrirModalBackupsAuto);
  $('btn-cerrar-auto-backups')?.addEventListener('click', cerrarModalBackupsAuto);
  $('auto-backups-modal-backdrop')?.addEventListener('click', cerrarModalBackupsAuto);

  $('auto-backups-body')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-auto-bkp]');
    if (!btn) return;
    const fname = btn.dataset.autoBkp;
    try {
      const res = await apiFetch(
        `/api/backups/automaticos/${encodeURIComponent(fname)}`
      );
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fname;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      mostrarToast(`Respaldo ${fname} descargado.`, 'ok');
    } catch (err) {
      mostrarToast(err.message, 'error');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (
      e.key === 'Escape' &&
      $('auto-backups-modal') &&
      !$('auto-backups-modal').classList.contains('hidden')
    ) {
      cerrarModalBackupsAuto();
    }
  });
}

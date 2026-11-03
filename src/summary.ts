import type { Config } from './config.js';
import type { Draft, Environment } from './invoice.js';
import { formatEuros } from './money.js';

export function envLabel(env: Environment, provider: string): string {
  if (env === 'production') return '[PRODUCCIÓN: facturas reales registradas en la AEAT]';
  return provider === 'mock' ? '[MOCK: nada se envía a ningún proveedor]' : '[SANDBOX: entorno de pruebas de la AEAT]';
}

export function formatDraftSummary(draft: Draft, config: Config): string {
  const t = draft.totales;
  const c = draft.cliente;
  const d = c.direccion;
  const out: string[] = [];

  out.push(envLabel(config.env, config.provider));
  out.push(
    draft.emision
      ? `Factura ${draft.emision.numero} · emitida el ${draft.emision.fecha} (${draft.emision.proveedor})`
      : `Borrador ${draft.id} · sin número (se asigna al emitir)`,
  );
  out.push('');
  const issuer = config.issuer;
  if (issuer.nombre || issuer.nif) {
    out.push(`Emisor:  ${[issuer.nombre, issuer.nif].filter(Boolean).join(' · ')}`);
  }
  out.push(`Cliente: ${c.nombre} · ${c.nif}`);
  out.push(`         ${d.calle}${d.numero ? ` ${d.numero}` : ''}, ${d.cp} ${d.ciudad} (${d.provincia})${d.pais ? `, ${d.pais}` : ''}`);
  if (draft.fecha_operacion) out.push(`Fecha de la operación: ${draft.fecha_operacion}`);
  out.push('');
  out.push('Líneas:');
  draft.lineas.forEach((l, i) => {
    const irpf = l.tipo === 'servicio' ? `IRPF ${l.irpf} %` : 'sin IRPF';
    out.push(
      `  ${i + 1}. ${l.descripcion} [${l.tipo}] ${l.cantidad} × ${formatEuros(Math.round(l.precio_unitario * 100))} = ${formatEuros(l.base)} · IVA ${l.iva} % · ${irpf}`,
    );
  });
  out.push('');
  out.push(`Base imponible:        ${formatEuros(t.base)}`);
  for (const row of t.ivaDesglose) {
    out.push(`IVA ${row.tipo} % s/ ${formatEuros(row.base)}: ${formatEuros(row.cuota)}`);
  }
  out.push(`IRPF ${t.irpfTipo} % s/ ${formatEuros(t.irpfBase)} (solo servicios): −${formatEuros(t.irpf)}`);
  out.push(`TOTAL FACTURA:         ${formatEuros(t.total)}`);
  if (t.yaPagado > 0) {
    out.push(`Ya abonado:            −${formatEuros(t.yaPagado)}`);
    out.push(`PENDIENTE DE PAGO:     ${formatEuros(t.pendiente)}`);
  }
  if (draft.notas) {
    out.push('');
    out.push(`Notas: ${draft.notas}`);
  }
  if (draft.emision) {
    out.push('');
    if (draft.emision.estadoVerifactu) out.push(`Estado VERI*FACTU: ${draft.emision.estadoVerifactu}`);
    for (const aviso of draft.emision.avisos) out.push(`⚠ ${aviso}`);
  }
  return out.join('\n');
}

export function formatList(drafts: Draft[], config: Config): string {
  if (drafts.length === 0) return `${envLabel(config.env, config.provider)}\nNo hay borradores ni facturas.`;
  const sorted = [...drafts].sort((a, b) => {
    // Issued invoices first, by number; then drafts, newest first.
    if (a.emision && b.emision) return a.emision.numero.localeCompare(b.emision.numero);
    if (a.emision) return -1;
    if (b.emision) return 1;
    return b.creado.localeCompare(a.creado);
  });
  const rows = sorted.map((d) => {
    const numero = d.emision?.numero ?? '—';
    const fecha = d.emision?.fecha ?? d.creado.slice(0, 10);
    const estado = d.emision ? 'emitida' : 'borrador';
    return `| ${numero} | ${fecha} | ${d.cliente.nombre} | ${formatEuros(d.totales.total)} | ${estado} | ${d.id} |`;
  });
  return [
    envLabel(config.env, config.provider),
    '| Número | Fecha | Cliente | Total | Estado | Borrador |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

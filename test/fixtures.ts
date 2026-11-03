import type { DraftInput } from '../src/invoice.js';

// B12345674 is the example NIF used in BeeL's public docs; valid checksum, not a real client.
export const CLIENT = {
  nombre: 'Cliente de Prueba SL',
  nif: 'B12345674',
  direccion: { calle: 'Calle Falsa', numero: '1', cp: '28001', ciudad: 'Madrid', provincia: 'Madrid' },
};

/** The reference case from the task: two service lines, two goods lines. */
export const REFERENCE_INPUT: DraftInput = {
  cliente: CLIENT,
  lineas: [
    { descripcion: 'Servicio profesional A', precio_unitario: 1700, tipo: 'servicio' },
    { descripcion: 'Servicio profesional B', precio_unitario: 260, tipo: 'servicio' },
    { descripcion: 'Material revendido a coste 1', precio_unitario: 727.19, tipo: 'bien' },
    { descripcion: 'Material revendido a coste 2', precio_unitario: 189.26, tipo: 'bien' },
  ],
  irpf: 7,
  ya_pagado: 1108.9,
};

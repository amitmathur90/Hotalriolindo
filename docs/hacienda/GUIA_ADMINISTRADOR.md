# Facturación electrónica — guía para el administrador, cajeros y contador

## 1. Puesta en marcha (administrador)

1. **ATV (Hacienda):** genere el *usuario y contraseña de la API* y descargue la *llave criptográfica (.p12)* con su PIN. Empiece con las credenciales de **pruebas**.
2. **Back Office → Hacienda → Configuración:**
   * Datos del emisor: razón social, cédula, actividad económica, provincia/cantón/distrito, dirección, teléfono, correo.
   * *Registro fiscal 8707* si vende bebidas alcohólicas.
   * Usuario y contraseña de la API, llave `.p12` + PIN → **Probar conexión y firma**.
   * *Sucursales y terminales:* número de sucursal de cada local, actividad del local (ej. 561001 restaurante) y una terminal por caja. **No use las mismas terminales que Cubo** u otro sistema.
   * *Numeración:* si viene de otro sistema, fije el siguiente número por tipo de documento.
   * *Catálogo CABYS:* importe el archivo oficial vigente y asigne a cada producto su código y unidad (filtro *Por revisar*).
3. Active en **Pruebas** y haga ventas de prueba. Cuando todo salga *Aceptado*, cambie a **Producción** con las credenciales de producción.

## 2. En la caja (cajero)

* Cada venta emite automáticamente un **tiquete electrónico**; el número y la clave salen en el recibo.
* Si el cliente pide **factura**, marque *Factura electrónica* en la pantalla de pago e ingrese su cédula, nombre y correo.
* El pago y el comprobante son independientes: si no hay internet la venta se guarda y el comprobante se envía después.
* Las devoluciones (Recibos → Reembolsar, con permiso) generan la **nota de crédito** automáticamente.

## 3. Estados de un comprobante

| Estado | Significado |
|---|---|
| En cola | Creado; se validará, firmará y enviará en segundos |
| Firmado / Enviado / Procesando | Hacienda lo recibió y aún no responde |
| **Aceptado** | Respuesta oficial de aceptación |
| **Rechazado** | Hacienda lo rechazó (ver motivo) → corregir y *Reemitir* |
| Validación fallida | No cumplió el esquema oficial o falta CABYS → corregir y *Reintentar* |
| Error de credenciales | Revise usuario/contraseña de la API |
| Revisión manual | No se pudo confirmar si Hacienda lo recibió → *Consultar estado* o revisar en ATV |

## 4. Documentos y ajustes

* **Emitidos:** haga clic en un comprobante para ver su historial completo, descargar el XML original, el firmado y la respuesta de Hacienda, el PDF A4 o el tiquete de 80/58 mm, y reenviar el correo.
* **Nota de crédito:** anulación total o ajuste parcial (descuento, corrección de monto). No puede superar el original.
* **Nota de débito:** cargos adicionales a una factura.
* **Nueva factura:** facturas o tiquetes manuales (hospedaje, eventos, tours) en colones o dólares.
* **Recibidos:** facturas de proveedores → aceptar / rechazar ante Hacienda.

## 5. Contador

El rol *Accountant* ve comprobantes, XML, PDF, reportes (ventas electrónicas, impuestos por tarifa, errores) y la contabilidad, y puede emitir notas si se le autoriza. Hacienda → **Reportes** exporta a CSV / Excel.

## 6. Mantenimiento

* La llave criptográfica vence: el sistema avisa 30 días antes. Cargue la nueva en Configuración.
* Cada año importe la versión nueva del catálogo CABYS.
* Revise semanalmente Hacienda → **Resumen** (cola vacía, sin errores).

# wa-audit

**Una auditoría comercial de tu número de WhatsApp de negocio.** Lo apuntás a
una instancia de [WAHA](https://github.com/devlikeapro/waha) y exporta el
historial completo, arma un corpus limpio de conversaciones, corre un análisis
con LLM que **se verifica contra el corpus antes de llegar a vos**, y entrega
un informe XLSX de múltiples hojas: tiempos de respuesta, preguntas frecuentes
reales, arquetipos de cliente, objeciones, qué podría resolver un bot — con
una hoja de metodología que registra lo que la verificación *refutó*.

Todo corre en tu máquina. No se sube nada a ningún lado.

*English version: [README.md](README.md).*

---

## ⚠️ Leé esto primero

> Este proyecto **no está afiliado, asociado, autorizado, avalado ni conectado
> oficialmente de ninguna forma con WhatsApp, Meta Platforms Inc.** ni con
> ninguna de sus subsidiarias. "WhatsApp" y "Meta", y los nombres, marcas e
> imágenes relacionados, son marcas registradas de sus respectivos titulares.
> El sitio oficial de WhatsApp es https://whatsapp.com.
>
> Tampoco está afiliado con el proyecto WAHA. Esta herramienta sólo consume la
> API HTTP de una instancia de WAHA que **vos** operás; no redistribuye,
> empaqueta ni modifica WAHA (que es Apache-2.0 y se obtiene de su repositorio
> oficial).
>
> WAHA usa métodos no oficiales para acceder a WhatsApp. **WhatsApp no permite
> bots ni clientes no oficiales en su plataforma**, y no hay garantía de que
> tu cuenta no sea bloqueada. Los mantenedores de este proyecto **no avalan
> ningún uso que viole los Términos de Servicio de WhatsApp** y desalientan
> expresamente la mensajería masiva, el spam, el stalkerware y la vigilancia
> de personas. Para integraciones críticas de negocio, considerá la API
> oficial de WhatsApp Business. El caso de uso previsto es un negocio
> analizando **su propio** historial de conversaciones.
>
> **Datos personales:** el historial de chats son datos personales de
> terceros. Sos el único responsable de tener una base legal válida para
> tratarlos y de cumplir la normativa que te aplique (GDPR, LGPD, Ley
> 25.326, …). El procesamiento ocurre íntegramente en tu propia
> infraestructura; este proyecto no transmite nada a sus autores ni a nadie.
>
> Este software se provee "TAL CUAL", sin garantías de ningún tipo.

---

## Por qué el verificador es el corazón del producto

Este pipeline se construyó para un negocio real: **11.782 mensajes, 610
conversaciones, 8 meses de historial**. El análisis LLM produjo 60 hallazgos
en 7 dimensiones. Después, cada dimensión pasó por un verificador
independiente que re-ubicó cada cita y recontó cada cifra contra el corpus.

**El verificador refutó 34 de los 60 hallazgos.**

Hallazgos plausibles, bien escritos, con números convincentes — y más de la
mitad no sobrevivió el contacto con los datos. Un análisis LLM de tu negocio
sin paso de verificación no es análisis: es ficción con formato lindo. Por eso
en este proyecto:

- cada hallazgo debe citar **evidencia textual** (`thread_id` + cita), y un
  chequeo determinístico de código refuta cualquier hallazgo cuya cita no
  exista en el corpus — ahí ningún modelo vota;
- un **segundo pase LLM independiente** recuenta cada afirmación de frecuencia
  y refuta lo que no se sostiene tal como está enunciado;
- el schema hace el veredicto **obligatorio**: un análisis sin verificación
  registrada es inválido por construcción;
- la hoja de metodología del informe **imprime los hallazgos refutados**, para
  que nadie vuelva a citar los números malos.

## Probalo en dos minutos (sin WhatsApp)

```bash
git clone <este repo> && cd wa-audit
npm install
npm run demo
```

El demo genera un corpus sintético, levanta un mock de WAHA, corre el pipeline
completo (probe → export → corpus → análisis verificado → informe) con un LLM
mock, y deja `out/demo/whatsapp-report.xlsx` listo para abrir. Sin claves, sin
red, sin datos reales.

## Correrlo contra tu WhatsApp real

Necesitás una instancia de [WAHA](https://waha.devlike.pro/) con tu número
conectado — [docs/waha-setup.md](docs/waha-setup.md) documenta las trampas que
nos costaron días (elección de engine, `fullSync`, slots de dispositivo, @lid).

```bash
cp waha.env.example waha.env        # completá WAHA_BASE_URL + WAHA_API_KEY
node --env-file=waha.env src/probe.mjs
node --env-file=waha.env src/export.mjs <nombre-de-sesión>
node --env-file=waha.env src/threads.mjs --session <nombre-de-sesión>
node --env-file=waha.env src/analyze.mjs     # necesita ANTHROPIC_API_KEY o endpoint compatible OpenAI
node src/report-xlsx.mjs
```

¿Preferís correr el análisis con tu propio agente (Claude Code, Cursor, lo que
sea) en vez del motor incluido? Es un camino de primera clase:
[analysis/PLAYBOOK.md](analysis/PLAYBOOK.md).

## Configuración, contrato de datos y límites

- Configuración: [`wa-audit.config.json`](wa-audit.config.json) + overrides
  por env (los secretos son sólo env; `WAHA_BASE_URL` no tiene default a
  propósito). Tabla completa en el [README en inglés](README.md#configuration).
- Contrato de datos versionado (`schema_version: 1`), documentado en
  [docs/data-contract.md](docs/data-contract.md); el contrato de análisis está
  formalizado en [analysis/analysis.schema.json](analysis/analysis.schema.json)
  — **cualquier motor que emita un `analysis.json` válido enchufa en el
  informe sin cambios**.
- Limitaciones honestas (NOWEB/GOWS solamente, `fullSync`, anclaje de la
  métrica de respuesta, media sin texto, el pin de `xlsx@0.18.5`): sección
  [Honest limitations](README.md#honest-limitations).

La prosa del informe hoy sale en castellano rioplatense (preset es-AR); la
estructura de datos de abajo es inglés. La i18n de la prosa está en el roadmap.

## Licencia

[MIT](LICENSE).

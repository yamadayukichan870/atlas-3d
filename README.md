# Atlas 3D

Plugin hermano de [Atlas VTT](https://github.com/atlas-vtt/atlas-vtt) para Obsidian: mapa **isométrico 3D** de la
escena abierta en Atlas, con **terreno construido con bloques** (cubo, rampa, escalón, losa, agua), **tokens 3D** con
sus recursos y el **statblock original de Atlas**. No modifica Atlas.

## Instalar y compilar

El proyecto vive en `<vault>/.obsidian/plugins/atlas-3d/`. En esa carpeta:

```
npm install        (solo la primera vez)
npm run build      (compila una vez y genera main.js)
```

Después reinicia Obsidian o desactiva y activa el plugin. `npm run dev` recompila al guardar; `npm test` ejecuta las
pruebas (una sola: `node test/one.mjs blockGeometry`).

## Dos formas de verlo

- **En un panel** junto a Atlas: icono de cubo de la cinta o comando *Open 3D map of the active Atlas scene*.
- **Dentro de Atlas**, bajo su propia interfaz (barra de herramientas, pestañas de escena, menús): comando *Toggle the
  3D map inside the active Atlas scene*, o el botón **Into Atlas** del panel. El botón **2D** vuelve al mapa de Atlas.
  Las herramientas de Atlas que actúan sobre su canvas 2D (mover el mapa, niebla, dibujo) no funcionan en 3D.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| **Orbit** | Izq. rota, der. desplaza, rueda zoom. Clic en un token lo selecciona (también en Atlas); clic derecho abre el menú de Atlas. |
| **Raise / Lower** | Pincel 1×1 a 3×3: pone o quita el bloque de arriba de cada columna. |
| **Build** | **Add / Rotate / Remove** de bloques. Forma, giro (**R**, Shift+R) y color en el panel. **Alt** = borrar. Un trazo trabaja en un solo nivel. |
| **Move** | Arrastra un token con snap a la cuadrícula; se escribe en Atlas. |

**Map image / Block colours** alterna la cara superior entre la imagen del mapa y los colores de bloque. **Layer** alterna
la altura de una capa entre 1 celda (cubo real, la losa mide la mitad) y ½. Ctrl/Cmd+Z deshace el terreno; si no hay nada
que deshacer en 3D, la tecla pasa al deshacer de Atlas. Las teclas se leen solo con la vista enfocada.

## Statblock

Con **Ctrl + hover** sobre un personaje con statblock enlazado se abre **la ventana original de Atlas** (con su pin,
tiradas de dados y vitales). El plugin solo avisa a Atlas de que el puntero está sobre el token, exactamente como lo hace su
propio mapa; no dibuja nada.

## Comprobar la compatibilidad con Atlas

Atlas no publica API. Este plugin usa partes que Atlas mantiene privadas (el bus de eventos, el menú de tokens, las
definiciones de recursos). Todas están en **un solo archivo**, `src/atlas/internals.ts`, y cada una se comprueba antes de
usarse. El comando **Check compatibility with Atlas VTT** muestra cuáles están disponibles en tu Atlas y qué deja de
funcionar sin cada una; tiene un botón para copiar el informe. Tras actualizar Atlas, es lo primero que conviene mirar.

## Dónde se guarda el terreno

`Atlas3D/<escena>.json` (carpeta configurable; nunca dentro de `atlas-vtt/`). Un bloque por línea, en el orden de IsoCON:
`x|z|y|rotación|forma|destruible|marcas|colorTapa|colorLado`. Los archivos de versiones anteriores y los
`<escena>.atlasmap.3d.json` de Tactical 3D se migran solos (se leen, no se modifican). Un archivo ilegible se copia a
`.broken` antes de que una edición pueda sobrescribirlo.

## Pendiente (plan por fases)

- **Base del token ceñida al terreno** (rampas y escaleras): un solo mecanismo que sustituya disco, relleno e inclinación.
- **HUD de recursos con la lógica de Atlas**: colores amarillo/rojo (`defeatedWhenSpent`), visibilidad en hover y
  selección, valores escritos (`-10-5`, `-9/2`), cambio sobre varios tokens a la vez.
- **Giro y tamaño del token** (pasos de 15°/45°, recentrado) y aspecto igual al de Atlas.
- Silueta "rayos X", regla 3D con elevación, gizmo de navegación, números de daño, alcance de movimiento sobre el terreno.
- Interfaz solo en inglés por ahora.

## Licencias

Atlas VTT es AGPL-3.0 (con permiso adicional para Obsidian) e IsoCON GPL-3.0. Este código está escrito desde cero: no se
copió código de Atlas ni de IsoCON. `package.json` dice `AGPL-3.0-only` como opción conservadora; es decisión tuya, y no
soy abogado.

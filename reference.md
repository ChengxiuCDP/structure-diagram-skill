# 最小骨架

抽自一套已上线的实现，去掉了项目专属内容。token 名按所在项目替换。

## 容器与箭头

```tsx
function DiagramFigure({ title, caption, children }: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <figure className="project-diagram">
      <figcaption>{title}</figcaption>
      <div className="project-diagram__scroll">{children}</div>
      {caption ? <p className="project-diagram__caption">{caption}</p> : null}
    </figure>
  );
}

/** id 每图唯一：同页多图共用会互相污染。 */
function ArrowMarker({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} markerWidth="7" markerHeight="7" refX="6" refY="3"
              orient="auto" markerUnits="userSpaceOnUse">
        <path d="M0,0 L6,3 L0,6 Z" fill="var(--blue)" />
      </marker>
    </defs>
  );
}
```

配套 CSS 的要点（完整值按项目规范定）：

```css
.project-diagram__scroll { overflow-x: auto; }
.project-diagram__svg {
  display: block; width: 100%; height: auto;
  /* 视口收窄时不再等比缩小，改由外层横向滚动，保证小字号不掉到读不了。 */
  min-width: 720px;
}
.project-diagram__svg text { font-family: var(--mono); }
```

## 一张完整的图

演示三件事：按真实比例的漏斗、闭合回边、状态填充只用在人工介入点。

```tsx
export function EvalLoopDiagram() {
  const arrow = "eval-loop-arrow";
  const chain = [
    { id: "trace", label: "TRACE", zh: "完整 Session" },
    { id: "human", label: "HUMAN", zh: "复核与校准" },
  ];
  const boxWidth = 124;
  const boxGap = 10;

  return (
    <DiagramFigure title="评测闭环" caption="末端回流构成闭环，不是单向流程。">
      <svg
        className="project-diagram__svg"
        viewBox="0 0 800 460"
        role="img"
        aria-labelledby="eval-loop-title eval-loop-desc"
      >
        <title id="eval-loop-title">评测闭环示意图</title>
        <desc id="eval-loop-desc">
          上方是按真实量级收敛的漏斗，入口一万条以上，出口约五百条，收敛比约二十比一。
          出口向下进入链路，末端有一条回边绕过整张图底部与左侧指回入口，表示结果回流。
        </desc>
        <ArrowMarker id={arrow} />

        {/* 漏斗：120px 收到 6px，是真实的 20:1，不是示意 */}
        <polygon points="60,80 300,80 186,200 174,200"
                 fill="var(--fill)" stroke="var(--line)" strokeWidth="1" />
        <text className="pdiag-label" x="320" y="96">TRAFFIC</text>
        <text className="pdiag-value" x="320" y="114">10,000+ / DAY</text>

        {chain.map((step, index) => {
          const x = 60 + index * (boxWidth + boxGap);
          const isHuman = step.id === "human";
          return (
            <g key={step.id}>
              <rect
                x={x} y="310" width={boxWidth} height="64"
                /* 第二种填充只标记状态差异——这里是人工介入点 */
                fill={isHuman ? "var(--tint-blue)" : "var(--paper-soft)"}
                stroke={isHuman ? "var(--blue)" : "var(--line)"}
                strokeWidth="1"
              />
              <text className="pdiag-label" x={x + boxWidth / 2} y="336" textAnchor="middle">
                {step.label}
              </text>
              <text className="pdiag-value" x={x + boxWidth / 2} y="356" textAnchor="middle">
                {step.zh}
              </text>
            </g>
          );
        })}

        {/* 回边：绕底部与左侧回到入口，环上没有终点 */}
        <path d="M720,342 L752,342 L752,430 L40,430 L40,64 L172,64 L172,74"
              fill="none" stroke="var(--blue)" strokeWidth="1"
              markerEnd={`url(#${arrow})`} />
        {/* 回边穿过标签处，用纸面色矩形垫底断线，避免线压字 */}
        <rect x="272" y="416" width="256" height="26" fill="var(--paper)" />
        <text className="pdiag-value" x="284" y="434">结果回流</text>
      </svg>
    </DiagramFigure>
  );
}
```

## 几个反复用到的手法

- **回边压字**：连线穿过文字时，在文字下垫一个纸面色 `<rect>` 把线断开，比绕路好看。
- **引出线兼作标注**：横切漏斗的过滤线直接延伸到右侧标注列，一条线干两件事，比另画一条引线干净。
- **对齐标注列**：图形里塞不下的文字统一挪到一个固定 x 的标注列，不要硬塞进斜边里——文字压斜边是最常见的溢出。
- **纯数据驱动坐标**：`x = start + index * (width + gap)`，不要手写每个坐标，改间距时只改一个数。

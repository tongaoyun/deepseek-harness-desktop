import React from "react";

type Create = typeof React.createElement;

/** 多行输入沿用原生 textarea 属性和产品输入样式。 */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, rows = 4, ...rest } = props;
  return React.createElement("textarea", {
    ...rest,
    className: ["dssm-textarea", className].filter(Boolean).join(" "),
    rows,
  });
}

/** 来源和仓库折叠箭头。方向由 aria-expanded 决定，不靠动画结束才算展开。 */
export function foldChevron(h: Create, open: boolean) {
  return h("svg", {
    className: "dssm-fold-chevron" + (open ? " is-open" : ""),
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": true,
  }, h("path", { d: "M4 6l4 4 4-4", strokeLinecap: "round", strokeLinejoin: "round" }));
}

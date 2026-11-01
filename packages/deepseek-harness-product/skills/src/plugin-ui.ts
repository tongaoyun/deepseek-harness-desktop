import React from "react";

/** 多行输入沿用原生 textarea 属性和产品输入样式。 */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, rows = 4, ...rest } = props;
  return React.createElement("textarea", {
    ...rest,
    className: ["dssm-textarea", className].filter(Boolean).join(" "),
    rows,
  });
}

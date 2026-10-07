"use client";
import s from "@/app/plans/[id]/print/print.module.css";

export function PrintButton() {
  return (
    <button type="button" className={s.printBtn} onClick={() => window.print()} data-testid="print-button">
      Print this sheet
    </button>
  );
}

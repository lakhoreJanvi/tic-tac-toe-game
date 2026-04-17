import React from "react";

function renderCell(v) {
  if (v === 1) return "X";
  if (v === 2) return "O";
  return "";
}

export default function Board({ board, onMove, disabled, highlights }) {
  const winSet = new Set(highlights ?? []);
  return (
    <div className="grid" role="grid" aria-label="Tic tac toe board">
      {board.map((v, idx) => {
        const empty = v === 0;
        const clickable = empty && !disabled;
        const isWin = winSet.has(idx);
        return (
          <div
            key={idx}
            className={`cell ${clickable ? "clickable" : ""} ${isWin ? "win" : ""}`}
            role="gridcell"
            aria-label={`Cell ${idx}`}
            onClick={() => clickable && onMove(idx)}
          >
            {renderCell(v)}
          </div>
        );
      })}
    </div>
  );
}

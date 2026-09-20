import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { glyph, palette } from "../theme.js";

export type PickerItem<T> = { value: T; label: string; hint?: string };

type PickerProps<T> = {
  title: string;
  items: readonly PickerItem<T>[];
  onDone: (chosen: PickerItem<T> | undefined) => void;
};

type State =
  | { kind: "choosing"; index: number }
  | { kind: "chosen"; index: number }
  | { kind: "left"; index: number };

export function Picker<T>({ title, items, onDone }: PickerProps<T>) {
  const { exit } = useApp();
  const [state, setState] = useState<State>({ kind: "choosing", index: 0 });
  // Keys can outrun a re-render, so the handler never reads the cursor from its closure.
  const cursor = useRef(0);
  const move = (index: number): void => {
    cursor.current = index;
    setState({ kind: "choosing", index });
  };

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        move(Math.max(0, cursor.current - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        move(Math.min(items.length - 1, cursor.current + 1));
        return;
      }
      if (key.return) {
        setState({ kind: "chosen", index: cursor.current });
        return;
      }
      if (key.escape) setState({ kind: "left", index: cursor.current });
    },
    { isActive: state.kind === "choosing" },
  );
  // Exit after the answer is drawn, not in the same tick.
  useEffect(() => {
    if (state.kind === "choosing") return;
    onDone(state.kind === "chosen" ? items[state.index] : undefined);
    exit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);
  const current = items[state.index];
  if (state.kind === "chosen") {
    return (
      <Text>
        <Text color={palette.mist}>{title} </Text>
        <Text color={palette.teal}>{current?.label}</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={palette.cloud} bold>
        {title}
      </Text>
      {items.map((item, index) => {
        const active = index === state.index;
        return (
          <Box key={item.label}>
            <Text color={active ? palette.teal : palette.ash}>{active ? glyph.arrow : " "} </Text>
            <Text color={active ? palette.teal : palette.cloud} bold={active}>
              {item.label}
            </Text>
            {item.hint ? <Text color={palette.mist}> {item.hint}</Text> : null}
          </Box>
        );
      })}
      <Text color={palette.ash}>
        ↑↓ move {glyph.dotSep} enter pick {glyph.dotSep} esc quit
      </Text>
    </Box>
  );
}

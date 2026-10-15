import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";
import "./select.css";

export type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = {
  id?: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
};

export function Select({
  id,
  label,
  value,
  options,
  disabled = false,
  onChange,
  className = "",
}: SelectProps) {
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeahead = useRef("");
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const optionsSignature = JSON.stringify(options.map(({ value: optionValue, label: optionLabel }) => [optionValue, optionLabel]));
  const previousControlState = useRef({ value, optionsSignature });
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  const openMenu = useCallback((startIndex = selectedIndex) => {
    if (disabled) return;
    setActiveIndex(options.length === 0 ? -1 : startIndex >= 0 ? startIndex : 0);
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    typeahead.current = "";
    if (typeaheadTimer.current !== undefined) clearTimeout(typeaheadTimer.current);
  }, []);

  const commit = useCallback((index: number) => {
    const option = options[index];
    if (disabled || !option) return;
    closeMenu();
    if (option.value !== value) onChange(option.value);
  }, [closeMenu, disabled, onChange, options, value]);

  useEffect(() => {
    if (disabled) closeMenu();
  }, [disabled, closeMenu]);

  useEffect(() => {
    const controlStateChanged = previousControlState.current.value !== value
      || previousControlState.current.optionsSignature !== optionsSignature;
    previousControlState.current = { value, optionsSignature };
    if (!open || !controlStateChanged) return;

    if (options.length === 0) setActiveIndex(-1);
    else if (selectedIndex >= 0) setActiveIndex(selectedIndex);
    else setActiveIndex((current) => Math.min(Math.max(current, 0), options.length - 1));
  }, [open, options.length, optionsSignature, selectedIndex, value]);

  useEffect(() => {
    if (!open) return;
    const activeOption = document.getElementById(`${listboxId}-option-${activeIndex}`);
    activeOption?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId, open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [closeMenu, open]);

  useEffect(() => () => {
    if (typeaheadTimer.current !== undefined) clearTimeout(typeaheadTimer.current);
  }, []);

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) closeMenu();
  };

  const handleOptionPointerDown = (event: PointerEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    commit(index);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (event.key === "Tab") {
      closeMenu();
      return;
    }

    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closeMenu();
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu(event.key === "ArrowDown" ? selectedIndex : selectedIndex >= 0 ? selectedIndex : options.length - 1);
      } else if (options.length > 0) {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const next = activeIndex < 0
          ? (direction > 0 ? 0 : options.length - 1)
          : (activeIndex + direction + options.length) % options.length;
        setActiveIndex(next);
      }
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) openMenu(event.key === "Home" ? 0 : options.length - 1);
      else if (options.length > 0) setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
      else if (activeIndex >= 0) commit(activeIndex);
      return;
    }

    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      typeahead.current += event.key.toLocaleLowerCase();
      if (typeaheadTimer.current !== undefined) clearTimeout(typeaheadTimer.current);
      typeaheadTimer.current = setTimeout(() => { typeahead.current = ""; }, 700);
      const start = open && activeIndex >= 0 ? activeIndex + 1 : 0;
      const ordered = [...options.slice(start), ...options.slice(0, start)];
      const match = ordered.find((option) => option.label.toLocaleLowerCase().startsWith(typeahead.current));
      if (match) {
        const matchIndex = options.findIndex((option) => option === match);
        if (open) setActiveIndex(matchIndex);
        else openMenu(matchIndex);
      }
    }
  };

  return (
    <div ref={rootRef} className={`custom-select${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="custom-select__trigger"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-activedescendant={activeOptionId}
        disabled={disabled}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      >
        <span className="custom-select__value">{selectedOption?.label ?? ""}</span>
        <span className="custom-select__chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={listboxId} className="custom-select__menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <div
              id={`${listboxId}-option-${index}`}
              key={`${option.value}-${index}`}
              className={`custom-select__option${index === activeIndex ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
              role="option"
              aria-selected={option.value === value}
              onPointerDown={(event) => handleOptionPointerDown(event, index)}
              onPointerMove={() => setActiveIndex(index)}
            >
              <span className="custom-select__option-label">{option.label}</span>
              <span className="custom-select__check" aria-hidden="true">✓</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

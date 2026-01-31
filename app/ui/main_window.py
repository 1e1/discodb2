import queue
import threading
import time
from typing import Dict, List, Optional, Tuple

import tkinter as tk
from tkinter import filedialog, ttk

from app.application.can_service import CanService
from app.application.dictionary_service import DictionaryService
from app.application.serial_service import SerialService
from app.config import DEFAULT_BITRATES, SIMULATOR_LABEL
from app.domain.models import FrameStats
from app.ui.tabs.dictionary_tab import DictionaryTab
from app.ui.tabs.diff_tab import DiffTab
from app.ui.tabs.live_tab import LiveTab
from app.ui.utils import format_ascii, format_data, heat_color


class CanApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("CANBus Discovery Toolkit")
        self.root.geometry("1080x720")

        self.device_var = tk.StringVar()
        self.bitrate_var = tk.StringVar(value=str(DEFAULT_BITRATES[2]))
        self.status_var = tk.StringVar(value="Ready.")
        self.device_display_var = tk.StringVar()
        self.bitrate_display_var = tk.StringVar()

        self.devices = []
        self.device_map: Dict[str, object] = {}
        self.can_service = CanService()
        self.serial_service = SerialService()

        self.serial_port_var = tk.StringVar()
        self.serial_ports: List[str] = []

        self.frame_stats: Dict[int, FrameStats] = {}
        self.tree_items: Dict[int, str] = {}
        self.selected_id: Optional[int] = None
        self.log_sizes: Dict[int, int] = {}
        self.log_bytes = 0
        self.log_limit_bytes = 32 * 1024 * 1024
        self.log_usage_var = tk.StringVar()

        self.dictionary_service = DictionaryService()
        self.name_editor: Optional[tk.Entry] = None

        self.blob_stats: Dict[int, FrameStats] = {}
        self.minus_stats: Dict[int, FrameStats] = {}
        self.blob_tree_items: Dict[int, str] = {}
        self.minus_tree_items: Dict[int, str] = {}
        self.diff_tree_items: Dict[int, str] = {}

        self.blob_hold_active = False
        self.minus_hold_active = False
        self.blob_toggle_var = tk.BooleanVar(value=False)
        self.minus_toggle_var = tk.BooleanVar(value=False)
        self.active_hold_target: Optional[str] = None

        self.max_frames_per_tick = 200
        self.max_serial_lines_per_tick = 100
        self._last_sort_ts = 0.0
        self._last_seen_ts = 0.0

        self._build_ui()
        self._refresh_devices()
        self._refresh_serial_ports()
        self._update_bitrate_display()
        self._update_log_usage()
        self._schedule_ui_refresh()

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.bind_all("<ButtonRelease-1>", self._handle_global_release)

    def _build_ui(self) -> None:
        self._build_menu()

        top_frame = ttk.Frame(self.root, padding=12)
        top_frame.pack(side=tk.TOP, fill=tk.X)

        ttk.Label(top_frame, text="Device:").grid(row=0, column=0, sticky=tk.W, padx=4)
        ttk.Label(top_frame, textvariable=self.device_display_var).grid(
            row=0, column=1, sticky=tk.W, padx=4
        )

        ttk.Label(top_frame, text="Bitrate:").grid(row=0, column=2, sticky=tk.W, padx=12)
        ttk.Label(top_frame, textvariable=self.bitrate_display_var).grid(
            row=0, column=3, sticky=tk.W, padx=4
        )

        self.sniff_button = ttk.Button(top_frame, text="Sniff", command=self._toggle_sniff)
        self.sniff_button.grid(row=0, column=4, sticky=tk.W, padx=12)

        status_frame = ttk.Frame(self.root, padding=(12, 0, 12, 6))
        status_frame.pack(side=tk.TOP, fill=tk.X)
        ttk.Label(status_frame, textvariable=self.status_var).pack(side=tk.LEFT)
        ttk.Label(status_frame, textvariable=self.log_usage_var).pack(side=tk.RIGHT)

        tab_frame = ttk.Notebook(self.root)
        tab_frame.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        self.live_tab = LiveTab(
            tab_frame,
            serial_port_var=self.serial_port_var,
            on_select=self._on_select,
            on_name_edit=self._start_name_edit,
            on_toggle_serial=self._toggle_serial,
            on_refresh_serial=self._refresh_serial_ports,
            on_send_serial=self._send_serial_command,
        )
        tab_frame.add(self.live_tab.frame, text="Live")

        self.tree = self.live_tab.tree
        self.inspector_title = self.live_tab.inspector_title
        self.byte_labels = self.live_tab.byte_labels
        self.history_list = self.live_tab.history_list
        self.serial_combo = self.live_tab.serial_combo
        self.serial_connect_button = self.live_tab.serial_connect_button
        self.serial_output = self.live_tab.serial_output
        self.serial_entry = self.live_tab.serial_entry

        self.diff_tab = DiffTab(
            tab_frame,
            blob_toggle_var=self.blob_toggle_var,
            minus_toggle_var=self.minus_toggle_var,
            on_hold_capture=self._set_hold_capture,
            on_toggle_capture=self._on_toggle_capture,
            on_reset=self._reset_diff_lists,
            on_diff=self._render_diff,
            on_name_edit=self._start_name_edit,
        )
        tab_frame.add(self.diff_tab.frame, text="Diff")

        self.blob_tree = self.diff_tab.blob_tree
        self.minus_tree = self.diff_tab.minus_tree
        self.diff_tree = self.diff_tab.diff_tree
        self.blob_status_label = self.diff_tab.blob_status_label
        self.minus_status_label = self.diff_tab.minus_status_label

        self.dictionary_tab = DictionaryTab(tab_frame, on_name_edit=self._start_name_edit)
        tab_frame.add(self.dictionary_tab.frame, text="Dictionary")
        self.dictionary_tree = self.dictionary_tab.dictionary_tree

    def _build_menu(self) -> None:
        menubar = tk.Menu(self.root)

        self.device_menu = tk.Menu(menubar, tearoff=0)
        self.device_menu.add_command(label="Refresh", command=self._refresh_devices)
        menubar.add_cascade(label="Device", menu=self.device_menu)

        bitrate_menu = tk.Menu(menubar, tearoff=0)
        for rate in DEFAULT_BITRATES:
            bitrate_menu.add_radiobutton(
                label=str(rate),
                value=str(rate),
                variable=self.bitrate_var,
                command=self._update_bitrate_display,
            )
        menubar.add_cascade(label="Bitrate", menu=bitrate_menu)

        dict_menu = tk.Menu(menubar, tearoff=0)
        dict_menu.add_command(label="Save", command=self._dict_save)
        dict_menu.add_command(label="Save As", command=self._dict_save_as)
        dict_menu.add_command(label="Import", command=self._dict_import)
        menubar.add_cascade(label="Dict", menu=dict_menu)

        log_menu = tk.Menu(menubar, tearoff=0)
        log_kb_menu = tk.Menu(log_menu, tearoff=0)
        log_mb_menu = tk.Menu(log_menu, tearoff=0)
        for value in (2, 4, 8, 32, 64, 128, 256, 512, 1024):
            log_kb_menu.add_command(
                label=str(value),
                command=lambda v=value: self._set_log_limit("kb", v),
            )
            log_mb_menu.add_command(
                label=str(value),
                command=lambda v=value: self._set_log_limit("mb", v),
            )
        log_menu.add_cascade(label="Ko", menu=log_kb_menu)
        log_menu.add_cascade(label="Mo", menu=log_mb_menu)
        menubar.add_cascade(label="Log", menu=log_menu)

        self.root.config(menu=menubar)

    def _refresh_devices(self) -> None:
        devices = self.can_service.list_devices()
        self.devices = devices
        self.device_map = {device.label: device for device in devices}
        self._rebuild_device_menu()

        if devices:
            preferred = next((d.label for d in devices if "Canable" in d.label), devices[0].label)
            if self.device_var.get() not in self.device_map:
                self.device_var.set(preferred)
        else:
            self.device_var.set(SIMULATOR_LABEL)
        self._update_device_display()
        self.status_var.set("Device list updated.")

    def _rebuild_device_menu(self) -> None:
        self.device_menu.delete(1, tk.END)
        for device in self.devices:
            self.device_menu.add_radiobutton(
                label=device.label,
                value=device.label,
                variable=self.device_var,
                command=self._update_device_display,
            )

    def _refresh_serial_ports(self) -> None:
        self.serial_ports = self.serial_service.list_ports()
        self.serial_combo["values"] = self.serial_ports
        if self.serial_ports:
            if self.serial_port_var.get() not in self.serial_ports:
                self.serial_port_var.set(self.serial_ports[0])
        else:
            self.serial_port_var.set("")

    def _toggle_sniff(self) -> None:
        if self.can_service.is_running():
            self._stop_sniff()
        else:
            self._start_sniff()

    def _start_sniff(self) -> None:
        device = self.device_map.get(self.device_var.get())
        if not device:
            self.status_var.set("No device selected.")
            return

        bitrate = int(self.bitrate_var.get())
        self.frame_stats.clear()
        self.tree_items.clear()
        self.log_sizes.clear()
        self.log_bytes = 0
        for item in self.tree.get_children():
            self.tree.delete(item)
        self._clear_inspector()
        self._update_log_usage()

        try:
            self.can_service.start(device, bitrate)
        except Exception as exc:
            self.status_var.set(f"Unable to open device: {exc}")
            return
        self.sniff_button.config(text="Stop")
        self.status_var.set("Sniffing...")

    def _stop_sniff(self) -> None:
        self.can_service.stop()
        self.sniff_button.config(text="Sniff")
        self.status_var.set("Stopped.")
        self._update_capture_labels()

    def _toggle_serial(self) -> None:
        if self.serial_service.is_connected():
            self._disconnect_serial()
        else:
            self._connect_serial()

    def _connect_serial(self) -> None:
        port = self.serial_port_var.get()
        if not port:
            self._append_serial_log("No serial port selected.")
            return
        try:
            self.serial_service.connect(port)
        except Exception as exc:
            self._append_serial_log(f"Unable to open port: {exc}")
            return
        self.serial_connect_button.config(text="Disconnect")
        self._append_serial_log(f"Connected to {port}")

    def _disconnect_serial(self) -> None:
        self.serial_service.disconnect()
        self.serial_connect_button.config(text="Connect")
        self._append_serial_log("Disconnected.")

    def _schedule_ui_refresh(self) -> None:
        updated = self._drain_queue(self.max_frames_per_tick)
        self._drain_serial_queue(self.max_serial_lines_per_tick)
        now = time.time()
        if now - self._last_seen_ts >= 0.5:
            self._update_last_seen()
            self._last_seen_ts = now
        if updated and now - self._last_sort_ts >= 0.5:
            self._refresh_tree_order(self.tree, self.tree_items, self.frame_stats)
            self._refresh_tree_order(self.blob_tree, self.blob_tree_items, self.blob_stats)
            self._refresh_tree_order(self.minus_tree, self.minus_tree_items, self.minus_stats)
            self._last_sort_ts = now
        if updated:
            self._enforce_log_limit()
            self._update_log_usage()
        self.root.after(250, self._schedule_ui_refresh)

    def _drain_queue(self, max_items: int) -> bool:
        updated = False
        processed = 0
        while processed < max_items:
            try:
                arbitration_id, dlc, data, timestamp = self.can_service.reader_queue.get_nowait()
            except queue.Empty:
                break
            stats = self.frame_stats.get(arbitration_id)
            if stats is None:
                stats = FrameStats(
                    arbitration_id=arbitration_id,
                    dlc=dlc,
                    last_data=data,
                    count=1,
                    first_time=timestamp,
                    last_time=timestamp,
                )
                stats.history.appendleft(format_data(data))
                self.frame_stats[arbitration_id] = stats
                self._update_log_size(stats)
                self._insert_row(self.tree, self.tree_items, stats)
            else:
                stats.update(data, dlc, timestamp, format_data)
                self._update_log_size(stats)
                self._update_row(self.tree, self.tree_items, stats)
            if self.selected_id == arbitration_id:
                self._render_inspector(stats)
            updated = True
            processed += 1

            if self._is_capturing("blob"):
                self._capture_frame(self.blob_stats, self.blob_tree, self.blob_tree_items, stats, timestamp)
            if self._is_capturing("minus"):
                self._capture_frame(
                    self.minus_stats, self.minus_tree, self.minus_tree_items, stats, timestamp
                )
        return updated

    def _drain_serial_queue(self, max_items: int) -> None:
        processed = 0
        while processed < max_items:
            try:
                entry = self.serial_service.read_queue.get_nowait()
            except queue.Empty:
                return
            self._append_serial_log(entry)
            processed += 1

    def _send_serial_command(self, event=None) -> None:
        command = self.serial_entry.get().strip()
        if not command:
            return
        try:
            self.serial_service.send(command)
        except Exception as exc:
            self._append_serial_log(f"Write failed: {exc}")
            return
        self._append_serial_log(f"> {command}")
        self.serial_entry.delete(0, tk.END)

    def _append_serial_log(self, text: str) -> None:
        self.serial_output.config(state=tk.NORMAL)
        self.serial_output.insert(tk.END, text + "\n")
        self.serial_output.see(tk.END)
        self.serial_output.config(state=tk.DISABLED)

    def _insert_row(self, tree: ttk.Treeview, item_map: Dict[int, str], stats: FrameStats) -> None:
        values = self._row_values(stats)
        item_id = tree.insert("", tk.END, values=values)
        item_map[stats.arbitration_id] = item_id

    def _update_row(self, tree: ttk.Treeview, item_map: Dict[int, str], stats: FrameStats) -> None:
        item_id = item_map.get(stats.arbitration_id)
        if item_id:
            tree.item(item_id, values=self._row_values(stats))

    def _row_values(self, stats: FrameStats) -> Tuple[str, str, str, str, str, str, str, str]:
        now = time.time()
        last_seen = now - stats.last_time
        elapsed = max(now - stats.first_time, 0.001)
        rate = stats.count / elapsed
        return (
            f"{stats.arbitration_id:03X}",
            self._get_name(stats.arbitration_id),
            str(stats.dlc),
            format_data(stats.last_data),
            format_ascii(stats.last_data),
            str(stats.count),
            f"{rate:0.2f}",
            f"{last_seen:0.1f}s",
        )

    def _update_last_seen(self) -> None:
        self._update_last_seen_for(self.tree, self.tree_items, self.frame_stats)
        self._update_last_seen_for(self.blob_tree, self.blob_tree_items, self.blob_stats)
        self._update_last_seen_for(self.minus_tree, self.minus_tree_items, self.minus_stats)
        self._update_last_seen_for(self.diff_tree, self.diff_tree_items, self._current_diff_stats())
        if self.selected_id is not None:
            stats = self.frame_stats.get(self.selected_id)
            if stats:
                self._render_inspector(stats)

    def _on_select(self, event) -> None:
        selection = self.tree.selection()
        if not selection:
            self.selected_id = None
            self._clear_inspector()
            return
        item_id = selection[0]
        values = self.tree.item(item_id, "values")
        if not values:
            return
        arbitration_id = self._parse_id(values[0])
        if arbitration_id is None:
            return
        self.selected_id = arbitration_id
        stats = self.frame_stats.get(arbitration_id)
        if stats:
            self._render_inspector(stats)

    def _render_inspector(self, stats: FrameStats) -> None:
        self.inspector_title.config(text=f"ID 0x{stats.arbitration_id:03X}")

        total_frames = max(stats.count - 1, 1)
        for index in range(8):
            change_ratio = stats.per_byte_changes[index] / total_frames
            color = heat_color(change_ratio)
            value = "--"
            if index < len(stats.last_data):
                value = f"{stats.last_data[index]:02X}"
            self.byte_labels[index].config(text=value, bg=color)

        self.history_list.delete(0, tk.END)
        for entry in stats.history:
            self.history_list.insert(tk.END, entry)

    def _clear_inspector(self) -> None:
        self.inspector_title.config(text="Select a frame to inspect.")
        for label in self.byte_labels:
            label.config(text="--", bg="#f5f5f5")
        self.history_list.delete(0, tk.END)

    def _set_hold_capture(self, target: str, is_active: bool) -> None:
        if target == "blob":
            self.blob_hold_active = is_active
        elif target == "minus":
            self.minus_hold_active = is_active
        self.active_hold_target = target if is_active else None
        self._update_capture_labels()

    def _on_toggle_capture(self) -> None:
        self._update_capture_labels()

    def _handle_global_release(self, event) -> None:
        if not self.active_hold_target:
            return
        if self.active_hold_target == "blob":
            self.blob_hold_active = False
        elif self.active_hold_target == "minus":
            self.minus_hold_active = False
        self.active_hold_target = None
        self._update_capture_labels()

    def _is_capturing(self, target: str) -> bool:
        if target == "blob":
            return self.blob_hold_active or self.blob_toggle_var.get()
        if target == "minus":
            return self.minus_hold_active or self.minus_toggle_var.get()
        return False

    def _update_capture_labels(self) -> None:
        blob_active = self._is_capturing("blob")
        minus_active = self._is_capturing("minus")

        self.blob_status_label.config(
            text="Capturing" if blob_active else "Idle",
            foreground="#2e7d32" if blob_active else "#666666",
        )
        self.minus_status_label.config(
            text="Capturing" if minus_active else "Idle",
            foreground="#2e7d32" if minus_active else "#666666",
        )

    def _capture_frame(
        self,
        stats_map: Dict[int, FrameStats],
        tree: ttk.Treeview,
        item_map: Dict[int, str],
        source_stats: FrameStats,
        timestamp: float,
    ) -> None:
        stats = stats_map.get(source_stats.arbitration_id)
        if stats is None:
            stats = FrameStats(
                arbitration_id=source_stats.arbitration_id,
                dlc=source_stats.dlc,
                last_data=source_stats.last_data,
                count=1,
                first_time=timestamp,
                last_time=timestamp,
            )
            stats.history.appendleft(format_data(source_stats.last_data))
            stats_map[source_stats.arbitration_id] = stats
            self._insert_row(tree, item_map, stats)
        else:
            stats.update(source_stats.last_data, source_stats.dlc, timestamp, format_data)
            self._update_row(tree, item_map, stats)

    def _reset_diff_lists(self) -> None:
        self.blob_stats.clear()
        self.minus_stats.clear()
        self.blob_tree_items.clear()
        self.minus_tree_items.clear()
        self.diff_tree_items.clear()
        for item in self.blob_tree.get_children():
            self.blob_tree.delete(item)
        for item in self.minus_tree.get_children():
            self.minus_tree.delete(item)
        for item in self.diff_tree.get_children():
            self.diff_tree.delete(item)
        self._update_capture_labels()

    def _render_diff(self) -> None:
        self.diff_tree_items.clear()
        for item in self.diff_tree.get_children():
            self.diff_tree.delete(item)

        diff_stats = self._current_diff_stats()
        for stats in diff_stats.values():
            self._insert_row(self.diff_tree, self.diff_tree_items, stats)
        self._refresh_tree_order(self.diff_tree, self.diff_tree_items, diff_stats)

    def _current_diff_stats(self) -> Dict[int, FrameStats]:
        minus_ids = set(self.minus_stats.keys())
        return {arb_id: stats for arb_id, stats in self.blob_stats.items() if arb_id not in minus_ids}

    def _refresh_tree_order(
        self,
        tree: ttk.Treeview,
        item_map: Dict[int, str],
        stats_map: Dict[int, FrameStats],
    ) -> None:
        ordered = sorted(
            stats_map.values(),
            key=lambda stats: stats.last_time,
            reverse=True,
        )
        for index, stats in enumerate(ordered):
            item_id = item_map.get(stats.arbitration_id)
            if item_id:
                tree.move(item_id, "", index)

    def _update_last_seen_for(
        self,
        tree: ttk.Treeview,
        item_map: Dict[int, str],
        stats_map: Dict[int, FrameStats],
    ) -> None:
        for arbitration_id, stats in stats_map.items():
            item_id = item_map.get(arbitration_id)
            if item_id:
                values = list(tree.item(item_id, "values"))
                if not values:
                    continue
                last_seen = time.time() - stats.last_time
                values[-1] = f"{last_seen:0.1f}s"
                tree.item(item_id, values=values)

    def _update_device_display(self) -> None:
        label = self.device_var.get() or "None"
        self.device_display_var.set(label)

    def _update_bitrate_display(self) -> None:
        self.bitrate_display_var.set(f"{self.bitrate_var.get()} bps")

    def _get_name(self, arbitration_id: int) -> str:
        return self.dictionary_service.get_name(arbitration_id)

    def _start_name_edit(self, event) -> None:
        tree = event.widget
        if not isinstance(tree, ttk.Treeview):
            return
        region = tree.identify("region", event.x, event.y)
        if region != "cell":
            return
        column_id = tree.identify_column(event.x)
        columns = tree["columns"]
        if not columns:
            return
        column_index = int(column_id.replace("#", "")) - 1
        column_key = columns[column_index]
        if column_key != "name":
            return
        row_id = tree.identify_row(event.y)
        if not row_id:
            return
        bbox = tree.bbox(row_id, column_id)
        if not bbox:
            return
        values = tree.item(row_id, "values")
        if not values:
            return
        arbitration_id = self._parse_id(values[0])
        if arbitration_id is None:
            return

        if self.name_editor:
            self.name_editor.destroy()
        self.name_editor = ttk.Entry(tree)
        self.name_editor.place(x=bbox[0], y=bbox[1], width=bbox[2], height=bbox[3])
        self.name_editor.insert(0, self._get_name(arbitration_id))
        self.name_editor.focus_set()

        def commit(event=None):
            new_name = self.name_editor.get().strip()
            self.dictionary_service.set_name(arbitration_id, new_name)
            self.name_editor.destroy()
            self.name_editor = None
            self._refresh_name_views()
            self._autosave_dictionary()

        self.name_editor.bind("<Return>", commit)
        self.name_editor.bind("<FocusOut>", commit)

    def _parse_id(self, value: str) -> Optional[int]:
        try:
            return int(value, 16)
        except ValueError:
            return None

    def _refresh_name_views(self) -> None:
        for stats in self.frame_stats.values():
            self._update_row(self.tree, self.tree_items, stats)
        for stats in self.blob_stats.values():
            self._update_row(self.blob_tree, self.blob_tree_items, stats)
        for stats in self.minus_stats.values():
            self._update_row(self.minus_tree, self.minus_tree_items, stats)
        for stats in self._current_diff_stats().values():
            if stats.arbitration_id in self.diff_tree_items:
                self._update_row(self.diff_tree, self.diff_tree_items, stats)
        self._refresh_dictionary_view()

    def _refresh_dictionary_view(self) -> None:
        for item in self.dictionary_tree.get_children():
            self.dictionary_tree.delete(item)
        for arbitration_id in sorted(dict(self.dictionary_service.items()).keys()):
            self.dictionary_tree.insert(
                "",
                tk.END,
                values=(f"{arbitration_id:03X}", self.dictionary_service.get_name(arbitration_id)),
            )

    def _dict_save(self) -> None:
        if not self.dictionary_service.path:
            self._dict_save_as()
            return
        self._write_dictionary(self.dictionary_service.path)

    def _dict_save_as(self) -> None:
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("Dictionary Files", "*.json"), ("All Files", "*.*")],
        )
        if not path:
            return
        self.dictionary_service.path = path
        self._write_dictionary(path)

    def _dict_import(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[("Dictionary Files", "*.json"), ("All Files", "*.*")]
        )
        if not path:
            return
        try:
            self.dictionary_service.load(path)
        except Exception as exc:
            self.status_var.set(f"Import failed: {exc}")
            return
        self._refresh_name_views()
        self.status_var.set("Dictionary imported.")

    def _write_dictionary(self, path: str) -> None:
        try:
            self.dictionary_service.save(path)
        except Exception as exc:
            self.status_var.set(f"Save failed: {exc}")
            return
        self.status_var.set("Dictionary saved.")

    def _autosave_dictionary(self) -> None:
        if not self.dictionary_service.path:
            return
        try:
            self.dictionary_service.save()
        except Exception as exc:
            self.status_var.set(f"Autosave failed: {exc}")

    def _set_log_limit(self, unit: str, value: int) -> None:
        if unit == "kb":
            self.log_limit_bytes = value * 1024
        else:
            self.log_limit_bytes = value * 1024 * 1024
        self._enforce_log_limit()
        self._update_log_usage()

    def _estimate_stats_size(self, stats: FrameStats) -> int:
        history_size = stats.dlc * len(stats.history)
        return 32 + stats.dlc + history_size

    def _update_log_size(self, stats: FrameStats) -> None:
        new_size = self._estimate_stats_size(stats)
        old_size = self.log_sizes.get(stats.arbitration_id, 0)
        self.log_sizes[stats.arbitration_id] = new_size
        self.log_bytes += new_size - old_size

    def _enforce_log_limit(self) -> None:
        while self.log_bytes > self.log_limit_bytes and self.frame_stats:
            oldest = min(self.frame_stats.values(), key=lambda entry: entry.last_time)
            self._remove_frame(oldest.arbitration_id)

    def _remove_frame(self, arbitration_id: int) -> None:
        stats = self.frame_stats.pop(arbitration_id, None)
        if not stats:
            return
        size = self.log_sizes.pop(arbitration_id, 0)
        self.log_bytes = max(self.log_bytes - size, 0)
        item_id = self.tree_items.pop(arbitration_id, None)
        if item_id:
            self.tree.delete(item_id)
        if self.selected_id == arbitration_id:
            self.selected_id = None
            self._clear_inspector()

    def _update_log_usage(self) -> None:
        self.log_usage_var.set(
            f"Log: {self._format_bytes(self.log_bytes)} / {self._format_bytes(self.log_limit_bytes)}"
        )

    def _format_bytes(self, value: int) -> str:
        if value >= 1024 * 1024:
            return f"{value / (1024 * 1024):.1f} Mo"
        return f"{value / 1024:.0f} Ko"

    def _on_close(self) -> None:
        self._stop_sniff()
        self._disconnect_serial()
        self.root.destroy()


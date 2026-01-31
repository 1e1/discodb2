import tkinter as tk

from app.ui.main_window import CanApp


def main() -> None:
    root = tk.Tk()
    app = CanApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()


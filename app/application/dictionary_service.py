from typing import Dict, Iterable, Tuple

from app.domain.dictionary_store import load_dictionary, save_dictionary


class DictionaryService:
    def __init__(self) -> None:
        self._id_names: Dict[int, str] = {}
        self.path: str | None = None

    def get_name(self, arbitration_id: int) -> str:
        return self._id_names.get(arbitration_id, "")

    def set_name(self, arbitration_id: int, name: str) -> None:
        if name:
            self._id_names[arbitration_id] = name
        else:
            self._id_names.pop(arbitration_id, None)

    def items(self) -> Iterable[Tuple[int, str]]:
        return self._id_names.items()

    def load(self, path: str) -> None:
        self._id_names = load_dictionary(path)
        self.path = path

    def save(self, path: str | None = None) -> None:
        target = path or self.path
        if not target:
            raise ValueError("No dictionary path set.")
        save_dictionary(target, self._id_names)
        self.path = target


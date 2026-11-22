"""Managed CPU-only Cohere CLI; shared plugin remains unmodified."""
import sys
from pathlib import Path


def main(argv=None):
    from asr_mcp.cli import build_parser, SUPPORTED_LANGUAGES, _format_basic, _format_diarized
    from asr_mcp.pipeline import apply_vocabulary, load_vocabulary, transcribe_with_diarization
    from cohere_cpu_model import create_cpu_model
    parser = build_parser()
    parser.set_defaults(backend="cohere")
    args = parser.parse_args(argv)
    if args.backend != "cohere":
        parser.error("Managed CPU CLI only supports Cohere")
    if args.list_languages:
        print("\n".join(f"{k}: {v}" for k, v in SUPPORTED_LANGUAGES.items()))
        return 0
    if not args.file or not args.language or args.language.lower() not in SUPPORTED_LANGUAGES:
        parser.error("An existing audio file and supported explicit language are required")
    audio = Path(args.file).resolve()
    if not audio.is_file():
        parser.error("Audio file does not exist")
    vocab = load_vocabulary(args.vocabulary)
    model = create_cpu_model()
    diarizer = None
    try:
        model.load()
        options = dict(file_path=audio, language=args.language.lower(), punctuation=not args.no_punctuation,
                       num_beams=args.num_beams, max_new_tokens=args.max_new_tokens,
                       repetition_penalty=args.repetition_penalty)
        if args.diarize:
            from asr_mcp.diarizer import DiarizationModel
            diarizer = DiarizationModel()
            diarizer.load("cpu")
            result = transcribe_with_diarization(**options, transcription_model=model,
                diarization_model=diarizer, vocabulary=vocab if vocab else None)
            output = _format_diarized(result, args.format)
        else:
            result = model.transcribe(**options)
            text = apply_vocabulary(result.text, vocab) if vocab else result.text
            output = _format_basic(text, result, args.format)
        if args.output:
            Path(args.output).write_text(output, encoding="utf-8")
        else:
            print(output)
        return 0
    finally:
        if diarizer is not None:
            diarizer.unload()
        model.unload()


if __name__ == "__main__":
    raise SystemExit(main())

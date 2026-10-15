#!/usr/bin/env python3

import argparse
import json
import sys
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Florence-2 on a rendered page image.")
    parser.add_argument("--input", required=True, help="Path to the page image.")
    parser.add_argument("--output", required=True, help="Path to the output JSON file.")
    parser.add_argument("--prompt", default="<OCR>", help="Florence-2 task prompt.")
    parser.add_argument(
        "--model",
        required=True,
        help="Hugging Face model id.",
    )
    parser.add_argument("--max-new-tokens", type=int, default=512, help="Generation budget.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started_at = time.perf_counter()
    try:
        import torch  # type: ignore
        from PIL import Image  # type: ignore
        from transformers import AutoModelForCausalLM, AutoProcessor  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "missing dependency: pip install pillow torch transformers accelerate "
            f"({exc})"
        )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        trust_remote_code=True,
        torch_dtype=dtype,
    ).to(device)

    image = Image.open(args.input).convert("RGB")
    inputs = processor(text=args.prompt, images=image, return_tensors="pt")
    inputs = {name: tensor.to(device) for name, tensor in inputs.items()}

    generated_ids = model.generate(
        input_ids=inputs.get("input_ids"),
        pixel_values=inputs.get("pixel_values"),
        max_new_tokens=args.max_new_tokens,
        num_beams=3,
    )
    generated_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    result = generated_text
    if hasattr(processor, "post_process_generation"):
        result = processor.post_process_generation(
            generated_text,
            task=args.prompt,
            image_size=image.size,
        )

    text = ""
    if isinstance(result, dict):
        prompt_value = result.get(args.prompt)
        if isinstance(prompt_value, str):
            text = prompt_value
        elif isinstance(prompt_value, list):
            text = "\n".join(str(item) for item in prompt_value)
        else:
            for value in result.values():
                if isinstance(value, str):
                    text = value
                    break
                if isinstance(value, list):
                    text = "\n".join(str(item) for item in value)
                    break
    elif isinstance(result, list):
        text = "\n".join(str(item) for item in result)
    else:
        text = str(result)

    input_tokens = int(inputs.get("input_ids").shape[-1]) if inputs.get("input_ids") is not None else 0
    total_tokens = int(generated_ids.shape[-1]) if hasattr(generated_ids, "shape") else 0
    output_tokens = max(0, total_tokens - input_tokens)
    latency_ms = int((time.perf_counter() - started_at) * 1000)

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "input": args.input,
                "model": args.model,
                "prompt": args.prompt,
                "device": device,
                "text": text.strip(),
                "result": result,
                "raw": generated_text,
                "latencyMs": latency_ms,
                "usage": {
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "source": "model",
                },
            },
            handle,
            indent=2,
        )
        handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

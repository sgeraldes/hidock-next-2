"""Explicit small isolated Cohere dependencies; never mutates the shared ASR venv."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
PINS = ['transformers==5.10.2', 'huggingface-hub==1.28.0', 'safetensors==0.8.0']
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--asr-python',required=True)
    args=parser.parse_args()
    root=Path(os.environ.get('LOCALAPPDATA',str(Path.home()))) / 'HiDock' / 'Runtime' / 'cohere'
    site=root / 'site'
    site.mkdir(parents=True,exist_ok=True)
    subprocess.run([args.asr_python,'-m','pip','install','--target',str(site),'--upgrade','--no-deps','--only-binary=:all:',*PINS],check=True,timeout=300)
    (root/'runtime.json').write_text(json.dumps({'pins':PINS,'importVerified':False,'inferenceVerified':False,'sharedEnvironmentModified':False}),encoding='utf-8')
if __name__=='__main__':main()

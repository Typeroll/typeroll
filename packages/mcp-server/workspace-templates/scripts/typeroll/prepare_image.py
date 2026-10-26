"""Convert a reviewed local original to an sRGB JPEG; never upload or change CMS content.
Requires Pillow with ImageCms. Preserve the untouched original in the source archive.
CMYK needs its actual embedded or supplied ICC profile. Never guess a CMYK profile.
Unprofiled RGB/gray requires --assume-srgb after review. Output must not exist.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path


def prepare(source, output, source_profile=None, assume_srgb=False, quality=95):
    from PIL import Image, ImageCms, ImageOps
    source, output = Path(source), Path(output)
    if output.exists() or source.resolve() == output.resolve():
        raise ValueError('Output already exists; choose a new derivative path.')
    if output.suffix.lower() not in ('.jpg', '.jpeg'):
        raise ValueError('Choose a .jpg or .jpeg output.')
    if not 1 <= quality <= 100:
        raise ValueError('JPEG quality must be from 1 to 100.')
    with Image.open(source) as original:
        if getattr(original, 'n_frames', 1) != 1:
            raise ValueError('Multi-page/animated originals require an explicit frame decision.')
        if 'A' in original.getbands() or 'transparency' in original.info:
            raise ValueError('Transparent originals need a reviewed background or a PNG workflow.')
        profile_bytes = Path(source_profile).read_bytes() if source_profile else original.info.get('icc_profile')
        image = ImageOps.exif_transpose(original)
        target = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB'))
        if profile_bytes:
            profile = ImageCms.ImageCmsProfile(io.BytesIO(profile_bytes))
            converted = ImageCms.profileToProfile(image, profile, target, outputMode='RGB')
        elif image.mode in ('RGB', 'L') and assume_srgb:
            converted = image.convert('RGB')
        else:
            raise ValueError('Missing source ICC profile. CMYK cannot be safely guessed; supply the correct --source-profile. For reviewed unprofiled RGB/gray only, use --assume-srgb.')
        # No source EXIF/GPS/caption metadata is copied into the public derivative.
        with output.open('xb') as destination:
            converted.save(destination, format='JPEG', quality=quality, subsampling=0, icc_profile=target.tobytes())
    with Image.open(output) as check:
        check.load()
        if check.mode != 'RGB' or not check.info.get('icc_profile'):
            raise ValueError('Output verification failed; do not upload the derivative.')
        dimensions = list(check.size)
    return {'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'output_sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'width': dimensions[0], 'height': dimensions[1], 'colour_space': 'sRGB',
            'source_profile': 'supplied' if source_profile else 'embedded' if profile_bytes else 'assumed sRGB',
            'uploaded': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--source-profile', type=Path)
    parser.add_argument('--assume-srgb', action='store_true')
    parser.add_argument('--quality', type=int, default=95)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.output, args.source_profile, args.assume_srgb, args.quality), indent=2))


if __name__ == '__main__':
    main()

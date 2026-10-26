"""Optional image-tool tests: run with Pillow/ImageCms installed. No customer files.
Set TEST_CMYK_PROFILE if the standard macOS profile is unavailable.
"""
import importlib.util,tempfile,pathlib,unittest,io,os
from PIL import Image,ImageCms
p=pathlib.Path(__file__).resolve().parents[1]/'packages/mcp-server/workspace-templates/scripts/typeroll/prepare_image.py'
spec=importlib.util.spec_from_file_location('prep',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_embedded_profile_and_orientation(self):
  with tempfile.TemporaryDirectory() as d:
   src=pathlib.Path(d)/'original.tif';out=pathlib.Path(d)/'web.jpg'
   image=Image.new('RGB',(30,20),(180,80,30));exif=Image.Exif();exif[274]=6;exif[315]='Private source metadata'
   image.save(src,icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes(),exif=exif)
   result=m.prepare(src,out)
   self.assertEqual((result['width'],result['height']),(20,30));self.assertFalse(result['uploaded'])
   with Image.open(out) as check:
    self.assertTrue(check.info['icc_profile']);self.assertNotIn(315,check.getexif())
    self.assertTrue(all(abs(a-b)<=3 for a,b in zip(check.getpixel((5,5)),(180,80,30))))
   with self.assertRaisesRegex(ValueError,'already exists'):m.prepare(src,out)
 def test_missing_cmyk_profile_is_not_guessed(self):
  with tempfile.TemporaryDirectory() as d:
   src=pathlib.Path(d)/'x.tif';out=pathlib.Path(d)/'x.jpg';Image.new('CMYK',(3,3),(1,2,3,4)).save(src)
   with self.assertRaisesRegex(ValueError,'Missing source ICC'):m.prepare(src,out,assume_srgb=True)
   self.assertFalse(out.exists())
 def test_unprofiled_rgb_needs_explicit_assumption(self):
  with tempfile.TemporaryDirectory() as d:
   src=pathlib.Path(d)/'x.png';out=pathlib.Path(d)/'x.jpg';Image.new('RGB',(3,3)).save(src)
   with self.assertRaisesRegex(ValueError,'Missing source ICC'):m.prepare(src,out)
   self.assertEqual(m.prepare(src,out,assume_srgb=True)['source_profile'],'assumed sRGB')
 def test_bad_profile_alpha_and_multiple_frames_stop(self):
  with tempfile.TemporaryDirectory() as d:
   src=pathlib.Path(d)/'x.tif';out=pathlib.Path(d)/'x.jpg'
   Image.new('RGBA',(3,3)).save(src)
   with self.assertRaisesRegex(ValueError,'Transparent'):m.prepare(src,out)
   Image.new('RGB',(3,3)).save(src,save_all=True,append_images=[Image.new('RGB',(3,3))])
   with self.assertRaisesRegex(ValueError,'Multi-page'):m.prepare(src,out)
   Image.new('RGB',(3,3)).save(src,icc_profile=b'not-a-profile')
   with self.assertRaises(Exception):m.prepare(src,out)
   self.assertFalse(out.exists())
 def test_embedded_cmyk_conversion_matches_profile_transform(self):
  profile=pathlib.Path(os.environ.get('TEST_CMYK_PROFILE','/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc'))
  if not profile.exists():self.skipTest('Set TEST_CMYK_PROFILE to a real CMYK ICC profile')
  with tempfile.TemporaryDirectory() as d:
   src=pathlib.Path(d)/'print.tif';out=pathlib.Path(d)/'web.jpg'
   original=Image.new('CMYK',(20,20),(120,20,50,10));original.save(src,icc_profile=profile.read_bytes())
   expected=ImageCms.profileToProfile(original,str(profile),ImageCms.createProfile('sRGB'),outputMode='RGB').getpixel((2,2))
   m.prepare(src,out)
   with Image.open(out) as check:self.assertTrue(all(abs(a-b)<=3 for a,b in zip(check.getpixel((2,2)),expected)))
   self.assertGreater(max(abs(a-b) for a,b in zip(expected,original.convert('RGB').getpixel((2,2)))),3)
unittest.main()

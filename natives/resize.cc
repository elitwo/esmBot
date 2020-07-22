#include <napi.h>
#include <list>
#include <Magick++.h>

using namespace std;
using namespace Magick;

class ResizeWorker : public Napi::AsyncWorker {
 public:
  ResizeWorker(Napi::Function& callback, string in_path, string type, int delay)
      : Napi::AsyncWorker(callback), in_path(in_path), type(type), delay(delay) {}
  ~ResizeWorker() {}

  void Execute() {
    list<Image> frames;
    list<Image> coalesced;
    list<Image> blurred;
    list<Image> result;
    readImages(&frames, in_path);
    coalesceImages(&coalesced, frames.begin(), frames.end());

    for (Image &image : coalesced) {
      image.scale(Geometry("10%"));
      image.scale(Geometry("1000%"));
      image.magick(type);
      blurred.push_back(image);
    }

    optimizeImageLayers(&result, blurred.begin(), blurred.end());
    if (delay != 0) for_each(result.begin(), result.end(), animationDelayImage(delay));
    writeImages(result.begin(), result.end(), &blob);
  }

  void OnOK() {
    Callback().Call({Env().Undefined(), Napi::Buffer<char>::Copy(Env(), (char *)blob.data(), blob.length())});
  }

 private:
  string in_path, type;
  int delay, wordlength, i, n, amount;
  size_t bytes, type_size;
  Blob blob;
};

Napi::Value Resize(const Napi::CallbackInfo &info)
{
  Napi::Env env = info.Env();

  string in_path = info[0].As<Napi::String>().Utf8Value();
  string type = info[1].As<Napi::String>().Utf8Value();
  int delay = info[2].As<Napi::Number>().Int32Value();
  Napi::Function cb = info[3].As<Napi::Function>();

  ResizeWorker* explodeWorker = new ResizeWorker(cb, in_path, type, delay);
  explodeWorker->Queue();
  return env.Undefined();
}
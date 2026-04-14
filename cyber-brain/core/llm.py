import os
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

load_dotenv()

def get_llm():
    """
    初始化并且返回大模型实例
    """
    api_key = os.getenv("QWEN_API_KEY")
    if not api_key:
        raise ValueError("请在 .env 文件中设置 QWEN_API_KEY 环境变量")
    base_url = os.getenv("QWEN_API_BASE_URL")
    if not base_url:
        raise ValueError("请在 .env 文件中设置 QWEN_API_BASE_URL 环境变量")
    llm = ChatOpenAI(api_key=api_key, base_url=base_url,model="qwen-turbo",temperature=0.8)
    return llm

if __name__ == "__main__":
    llm = get_llm()
    response = llm.invoke("你好，给我打个招呼！")
    print(response)